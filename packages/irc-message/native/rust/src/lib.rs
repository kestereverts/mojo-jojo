//! IRC tokenizer compiled to `wasm32-unknown-unknown` (`no_std`, no allocator).
//!
//! A faithful port of the reference state machine (see Tokenizer.ts). Reads
//! `in_len` bytes at `in_ptr` and writes `[type, start, end]` i32 triples at
//! `out_ptr`; returns the token count, or a negative status on a limit/assert
//! error (with `[errPos, errChar]` written to the first two slots at `out_ptr`).
//!
//! Built twice: scalar, and with `-C target-feature=+simd128` (the RFC1459-
//! portion scans use v128 to find delimiters 16 bytes at a time). Tag scans
//! stay scalar because they enforce `tag_data_limit` per byte.

#![no_std]

use core::panic::PanicInfo;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

/// Free-memory base (above static data + shadow stack) so the JS host knows
/// where it may place the input/output buffers without clobbering the runtime.
#[no_mangle]
pub extern "C" fn heap_base() -> u32 {
    extern "C" {
        static __heap_base: u8;
    }
    unsafe { &__heap_base as *const u8 as u32 }
}

#[inline(always)]
unsafe fn load8(p: u32) -> u8 {
    *(p as *const u8)
}

#[inline(always)]
unsafe fn store32(p: u32, v: i32) {
    *(p as *mut i32) = v;
}

// ---- delimiter scans (SIMD bulk + scalar tail) ----------------------------

/// Advance while the byte != ' '.
#[inline(always)]
unsafe fn scan_to_space(base: u32, mut pos: u32, end: u32) -> u32 {
    #[cfg(target_feature = "simd128")]
    {
        use core::arch::wasm32::*;
        let sp = u8x16_splat(b' ');
        while pos + 16 <= end {
            let v = v128_load((base + pos) as *const v128);
            let bits = u8x16_bitmask(u8x16_eq(v, sp));
            if bits != 0 {
                return pos + bits.trailing_zeros();
            }
            pos += 16;
        }
    }
    while pos < end && load8(base + pos) != b' ' {
        pos += 1;
    }
    pos
}

/// Advance to the next occurrence of `target` (used for batch line splitting).
#[inline(always)]
unsafe fn scan_to_byte(base: u32, mut pos: u32, end: u32, target: u8) -> u32 {
    #[cfg(target_feature = "simd128")]
    {
        use core::arch::wasm32::*;
        let t = u8x16_splat(target);
        while pos + 16 <= end {
            let v = v128_load((base + pos) as *const v128);
            let bits = u8x16_bitmask(u8x16_eq(v, t));
            if bits != 0 {
                return pos + bits.trailing_zeros();
            }
            pos += 16;
        }
    }
    while pos < end && load8(base + pos) != target {
        pos += 1;
    }
    pos
}

/// Advance while the byte == ' '.
#[inline(always)]
unsafe fn skip_spaces(base: u32, mut pos: u32, end: u32) -> u32 {
    #[cfg(target_feature = "simd128")]
    {
        use core::arch::wasm32::*;
        let sp = u8x16_splat(b' ');
        while pos + 16 <= end {
            let v = v128_load((base + pos) as *const v128);
            let ne = (!u8x16_bitmask(u8x16_eq(v, sp))) & 0xffff;
            if ne != 0 {
                return pos + ne.trailing_zeros();
            }
            pos += 16;
        }
    }
    while pos < end && load8(base + pos) == b' ' {
        pos += 1;
    }
    pos
}

/// Advance while the byte is a prefix-name char (not ' ', '@' or '!').
#[inline(always)]
unsafe fn scan_prefix_name(base: u32, mut pos: u32, end: u32) -> u32 {
    #[cfg(target_feature = "simd128")]
    {
        use core::arch::wasm32::*;
        let sp = u8x16_splat(b' ');
        let at = u8x16_splat(b'@');
        let ex = u8x16_splat(b'!');
        while pos + 16 <= end {
            let v = v128_load((base + pos) as *const v128);
            let m = v128_or(v128_or(u8x16_eq(v, sp), u8x16_eq(v, at)), u8x16_eq(v, ex));
            let bits = u8x16_bitmask(m);
            if bits != 0 {
                return pos + bits.trailing_zeros();
            }
            pos += 16;
        }
    }
    while pos < end {
        let c = load8(base + pos);
        if c == b' ' || c == b'@' || c == b'!' {
            break;
        }
        pos += 1;
    }
    pos
}

/// Advance while the byte is a prefix-user char (not ' ' or '@').
#[inline(always)]
unsafe fn scan_prefix_user(base: u32, mut pos: u32, end: u32) -> u32 {
    #[cfg(target_feature = "simd128")]
    {
        use core::arch::wasm32::*;
        let sp = u8x16_splat(b' ');
        let at = u8x16_splat(b'@');
        while pos + 16 <= end {
            let v = v128_load((base + pos) as *const v128);
            let bits = u8x16_bitmask(v128_or(u8x16_eq(v, sp), u8x16_eq(v, at)));
            if bits != 0 {
                return pos + bits.trailing_zeros();
            }
            pos += 16;
        }
    }
    while pos < end {
        let c = load8(base + pos);
        if c == b' ' || c == b'@' {
            break;
        }
        pos += 1;
    }
    pos
}

// ---- the tokenizer --------------------------------------------------------

struct Ctx {
    in_base: u32,
    out_base: u32,
    j: u32,
}

impl Ctx {
    #[inline(always)]
    unsafe fn byte(&self, pos: u32) -> u8 {
        load8(self.in_base + pos)
    }

    #[inline(always)]
    unsafe fn emit(&mut self, t: i32, s: u32, e: u32) {
        let a = self.out_base + self.j * 4;
        store32(a, t);
        store32(a + 4, s as i32);
        store32(a + 8, e as i32);
        self.j += 3;
    }

    #[inline(always)]
    unsafe fn finish(&mut self, p: u32) -> i32 {
        self.emit(0, p, p);
        (self.j / 3) as i32
    }

    #[inline(always)]
    unsafe fn err(&self, pos: u32, ch: u32, code: i32) -> i32 {
        store32(self.out_base, pos as i32);
        store32(self.out_base + 4, ch as i32);
        code
    }
}

#[no_mangle]
pub extern "C" fn tokenize(
    in_ptr: u32,
    in_len: u32,
    out_ptr: u32,
    _out_cap: u32,
    tag_data_limit: u32,
    tag_count_limit: u32,
    rfc1459_data_limit: u32,
    param_count_limit: u32,
) -> i32 {
    unsafe {
        let mut cx = Ctx { in_base: in_ptr, out_base: out_ptr, j: 0 };
        tokenize_range(
            &mut cx, in_ptr, 0, in_len,
            tag_data_limit, tag_count_limit, rfc1459_data_limit, param_count_limit,
        )
    }
}

/// Tokenize a CRLF-separated batch of lines in a single call. All triples are
/// written consecutively at `out_ptr` with absolute byte offsets; for each line
/// a `[firstTokenIndex, tokenCount]` i32 pair is written at `line_table_ptr`.
/// Returns the line count, or a negative status (first failing line).
#[no_mangle]
pub extern "C" fn tokenize_batch(
    in_ptr: u32,
    in_len: u32,
    out_ptr: u32,
    _out_cap: u32,
    line_table_ptr: u32,
    _line_table_cap: u32,
    tag_data_limit: u32,
    tag_count_limit: u32,
    rfc1459_data_limit: u32,
    param_count_limit: u32,
) -> i32 {
    unsafe {
        let mut cx = Ctx { in_base: in_ptr, out_base: out_ptr, j: 0 };
        let mut line_count: u32 = 0;
        let mut i: u32 = 0;
        while i < in_len {
            let le = scan_to_byte(in_ptr, i, in_len, b'\n');
            let mut content_end = le;
            if content_end > i && load8(in_ptr + content_end - 1) == b'\r' {
                content_end -= 1;
            }
            let first_token = cx.j / 3;
            // tokenize_range's return is the cumulative token count (its finish
            // emits into the shared cursor); derive this line's count from the
            // cursor delta and use the return only to detect an error.
            let status = tokenize_range(
                &mut cx, in_ptr, i, content_end,
                tag_data_limit, tag_count_limit, rfc1459_data_limit, param_count_limit,
            );
            if status < 0 {
                return status;
            }
            let line_tokens = cx.j / 3 - first_token;
            store32(line_table_ptr + line_count * 8, first_token as i32);
            store32(line_table_ptr + line_count * 8 + 4, line_tokens as i32);
            line_count += 1;
            i = le + 1;
        }
        line_count as i32
    }
}

/// Tokenize the absolute byte range `[start, end)` of `base`, appending triples
/// (with absolute offsets) via `cx`. Returns the token count for this range.
#[inline]
unsafe fn tokenize_range(
    cx: &mut Ctx,
    base: u32,
    start: u32,
    end: u32,
    tag_data_limit: u32,
    tag_count_limit: u32,
    rfc1459_data_limit: u32,
    param_count_limit: u32,
) -> i32 {
    let mut pos: u32 = start;

    if start >= end {
        return cx.finish(start);
    }

    // clean leading spaces
    pos = skip_spaces(base, pos, end);
    if pos >= end {
        return cx.finish(pos);
    }

    // ===== message tags =====
    if cx.byte(pos) == b'@' {
        let tag_data_limit_pos = pos + tag_data_limit;
        let mut tag_count: u32 = 0;

        if tag_data_limit == 0 {
            return cx.err(pos, 0, -1);
        }
        cx.emit(1, pos, pos + 1); // TagsStart
        pos += 1;
        if pos >= end {
            return cx.finish(pos);
        }
        if pos > tag_data_limit_pos {
            return cx.err(pos, 0, -1);
        }

        loop {
            if tag_count >= tag_count_limit {
                return cx.err(pos, 0, -2);
            }

            // TagKey (optional '+' client prefix)
            if cx.byte(pos) == b'+' {
                cx.emit(2, pos, pos + 1);
                pos += 1;
                if pos >= end {
                    return cx.finish(pos);
                }
                if pos > tag_data_limit_pos {
                    return cx.err(pos, 0, -1);
                }
            }
            let token_start = pos;
            let c = cx.byte(pos);
            if c != b'=' && c != b' ' && c != b';' {
                pos += 1;
                loop {
                    if pos >= end {
                        cx.emit(3, token_start, pos);
                        return cx.finish(pos);
                    }
                    if pos > tag_data_limit_pos {
                        return cx.err(pos, 0, -1);
                    }
                    let c = cx.byte(pos);
                    if c == b'=' || c == b' ' || c == b';' {
                        break;
                    }
                    pos += 1;
                }
                cx.emit(3, token_start, pos); // TagKey
            }

            // TagValueStart / TagValue
            if cx.byte(pos) == b'=' {
                cx.emit(4, pos, pos + 1);
                pos += 1;
                if pos >= end {
                    cx.emit(5, pos, pos); // empty TagValue
                    return cx.finish(pos);
                }
                if pos > tag_data_limit_pos {
                    return cx.err(pos, 0, -1);
                }
                let token_start = pos;
                let c = cx.byte(pos);
                if c != b' ' && c != b';' {
                    pos += 1;
                    loop {
                        if pos >= end {
                            cx.emit(5, token_start, pos);
                            return cx.finish(pos);
                        }
                        if pos > tag_data_limit_pos {
                            return cx.err(pos, 0, -1);
                        }
                        let c = cx.byte(pos);
                        if c == b' ' || c == b';' {
                            break;
                        }
                        pos += 1;
                    }
                }
                cx.emit(5, token_start, pos); // TagValue
            }

            tag_count += 1;

            // TagSeparator (';') or end-of-tags Separator (' ')
            let c = cx.byte(pos);
            if c == b';' {
                cx.emit(6, pos, pos + 1);
                pos += 1;
                if pos >= end {
                    return cx.finish(pos);
                }
                if pos > tag_data_limit_pos {
                    return cx.err(pos, 0, -1);
                }
                continue;
            }
            if c == b' ' {
                let token_start = pos;
                pos += 1;
                loop {
                    if pos >= end {
                        cx.emit(13, token_start, pos);
                        return cx.finish(pos);
                    }
                    if pos > tag_data_limit_pos {
                        cx.emit(13, token_start, pos);
                        return cx.err(pos, 0, -1);
                    }
                    if cx.byte(pos) != b' ' {
                        break;
                    }
                    pos += 1;
                }
                cx.emit(13, token_start, pos); // Separator
                break;
            }
            return cx.err(pos, c as u32, -5);
        }
    }

    // ===== RFC1459 portion length =====
    if end - pos > rfc1459_data_limit {
        return cx.err(pos, 0, -3);
    }

    // ===== prefix =====
    if cx.byte(pos) == b':' {
        cx.emit(7, pos, pos + 1); // PrefixStart
        pos += 1;
        if pos >= end {
            return cx.finish(pos);
        }

        // PrefixName
        let token_start = pos;
        pos = scan_prefix_name(base, pos, end);
        if pos > token_start {
            cx.emit(8, token_start, pos);
        }
        if pos >= end {
            return cx.finish(pos);
        }

        // PrefixUser
        if cx.byte(pos) == b'!' {
            cx.emit(9, pos, pos + 1); // PrefixUserStart
            pos += 1;
            if pos >= end {
                return cx.finish(pos);
            }
            let token_start = pos;
            pos = scan_prefix_user(base, pos, end);
            if pos > token_start {
                cx.emit(10, token_start, pos);
            }
            if pos >= end {
                return cx.finish(pos);
            }
        }

        // PrefixHost
        if cx.byte(pos) == b'@' {
            cx.emit(11, pos, pos + 1); // PrefixHostStart
            pos += 1;
            if pos >= end {
                return cx.finish(pos);
            }
            let token_start = pos;
            pos = scan_to_space(base, pos, end);
            if pos > token_start {
                cx.emit(12, token_start, pos);
            }
            if pos >= end {
                return cx.finish(pos);
            }
        }

        // trailing separator
        if cx.byte(pos) == b' ' {
            let token_start = pos;
            pos = skip_spaces(base, pos, end);
            cx.emit(13, token_start, pos);
            if pos >= end {
                return cx.finish(pos);
            }
        } else {
            return cx.err(pos, cx.byte(pos) as u32, -5);
        }
    }

    // ===== Command =====
    let token_start = pos;
    pos = scan_to_space(base, pos, end);
    cx.emit(14, token_start, pos);
    if pos >= end {
        return cx.finish(pos);
    }

    // ===== Separator =====
    let token_start = pos;
    pos = skip_spaces(base, pos, end);
    cx.emit(13, token_start, pos);
    if pos >= end {
        return cx.finish(pos);
    }

    // ===== Parameters =====
    let mut param_count: u32 = 0;
    loop {
        if param_count >= param_count_limit {
            return cx.err(pos, 0, -4);
        }
        param_count += 1;

        if cx.byte(pos) == b':' {
            cx.emit(16, pos, pos + 1); // TrailingParameterStart
            cx.emit(17, pos + 1, end); // TrailingParameter
            return cx.finish(end);
        }

        let token_start = pos;
        pos = scan_to_space(base, pos, end);
        cx.emit(15, token_start, pos); // MiddleParameter
        if pos >= end {
            return cx.finish(pos);
        }

        let token_start = pos;
        pos = skip_spaces(base, pos, end);
        cx.emit(13, token_start, pos); // Separator
        if pos >= end {
            return cx.finish(pos);
        }
    }
}
