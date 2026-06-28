import { TokenType } from "./Token.ts";
import {
  CHAR_AT,
  CHAR_SPACE,
  CHAR_PLUS,
  CHAR_EQUALS,
  CHAR_SEMICOLON,
  CHAR_COLON,
  CHAR_EXCL,
  isTagKeyChar,
  isTagValueChar,
  isPrefixNameChar,
  isPrefixUserChar,
} from "./chars.ts";
import { LimitExceededError, UnexpectedCharAssertionError } from "./errors.ts";
import { tripleCapacity, type TokenArray } from "./flat.ts";
import type { TokenizerOptions } from "./Tokenizer.ts";

// Token type values hoisted to locals so the hot loop reads plain numbers.
const T_EOF = TokenType.EOF;
const T_TagsStart = TokenType.TagsStart;
const T_TagClientKeyStart = TokenType.TagClientKeyStart;
const T_TagKey = TokenType.TagKey;
const T_TagValueStart = TokenType.TagValueStart;
const T_TagValue = TokenType.TagValue;
const T_TagSeparator = TokenType.TagSeparator;
const T_PrefixStart = TokenType.PrefixStart;
const T_PrefixName = TokenType.PrefixName;
const T_PrefixUserStart = TokenType.PrefixUserStart;
const T_PrefixUser = TokenType.PrefixUser;
const T_PrefixHostStart = TokenType.PrefixHostStart;
const T_PrefixHost = TokenType.PrefixHost;
const T_Separator = TokenType.Separator;
const T_Command = TokenType.Command;
const T_MiddleParameter = TokenType.MiddleParameter;
const T_TrailingParameterStart = TokenType.TrailingParameterStart;
const T_TrailingParameter = TokenType.TrailingParameter;

/**
 * Allocation-free tokenizer: a byte-for-byte port of the reference
 * {@link Tokenizer} state machine that writes `[type, start, end]` triples into
 * a reusable `Int32Array` instead of allocating one `Token` per token. Same
 * limit and error semantics, so it produces an identical token stream.
 *
 * The triple buffer is reused across calls — {@link tokenizeInto} returns a
 * count and leaves the triples in {@link tokens}, valid until the next call.
 * {@link tokenize} returns an owned copy for callers that need to keep it.
 */
export class JsFastTokenizer {
  public tagDataLimit = 8191;
  public tagCountLimit = 1000;
  public rfc1459DataLimit = 510;
  public paramCountLimit = 200;

  /** Reusable triple buffer; valid up to `count * 3` after a tokenize call. */
  public scratch = new Int32Array(0);
  /** Token count from the most recent {@link tokenizeInto}. */
  public count = 0;

  constructor(options: TokenizerOptions = {}) {
    if (typeof options.tagDataLimit === "number")
      this.tagDataLimit = options.tagDataLimit >>> 0;
    if (typeof options.tagCountLimit === "number")
      this.tagCountLimit = options.tagCountLimit >>> 0;
    if (typeof options.rfc1459DataLimit === "number")
      this.rfc1459DataLimit = options.rfc1459DataLimit >>> 0;
    if (typeof options.paramCountLimit === "number")
      this.paramCountLimit = options.paramCountLimit >>> 0;
  }

  /** Token getter mirroring the reusable buffer. */
  public get tokens(): Int32Array {
    return this.scratch;
  }

  /**
   * Tokenize into the reusable buffer; returns the token count. The triples
   * live in {@link scratch} (and {@link tokens}) until the next call.
   */
  public tokenizeInto(
    buffer: Uint8Array,
    start = 0,
    end = buffer.length,
  ): number {
    start = Math.max(0, start) >>> 0;
    end = Math.min(buffer.length, end) >>> 0;

    const tagDataLimit = this.tagDataLimit >>> 0;
    const tagCountLimit = this.tagCountLimit >>> 0;
    const rfc1459DataLimit = this.rfc1459DataLimit >>> 0;
    const paramCountLimit = this.paramCountLimit >>> 0;

    const cap = tripleCapacity(end - start);
    if (this.scratch.length < cap) this.scratch = new Int32Array(cap);
    const out = this.scratch;
    let j = 0;

    const emit = (type: number, s: number, e: number): void => {
      out[j] = type;
      out[j + 1] = s;
      out[j + 2] = e;
      j += 3;
    };
    const finish = (p: number): number => {
      out[j] = T_EOF;
      out[j + 1] = p;
      out[j + 2] = p;
      j += 3;
      this.count = j / 3;
      return this.count;
    };
    // Last emitted token's type, for error context (cosmetic, error path only).
    const lastTok = (): { type: number } | undefined =>
      j > 0 ? { type: out[j - 3]! } : undefined;

    let pos = start >>> 0;
    if (end - start === 0) {
      return finish(pos);
    }

    // clean leading spaces
    for (;; pos++) {
      if (pos >= end) return finish(pos);
      if (buffer[pos] !== CHAR_SPACE) break;
    }

    // message tags
    if (buffer[pos] === CHAR_AT) {
      const tagDataLimitPos = pos + tagDataLimit;
      let tagCount = 0;

      if (tagDataLimit === 0) {
        throw new LimitExceededError("tagDataLimit", tagDataLimit, pos, lastTok());
      }
      emit(T_TagsStart, pos, pos + 1);
      pos++;
      if (pos >= end) return finish(pos);
      if (pos > tagDataLimitPos) {
        throw new LimitExceededError("tagDataLimit", tagDataLimit, pos, lastTok());
      }
      // TAG:
      for (;;) {
        if (tagCount >= tagCountLimit) {
          throw new LimitExceededError("tagCountLimit", tagCountLimit, pos, lastTok());
        }
        // TagKey
        {
          if (buffer[pos] === CHAR_PLUS) {
            emit(T_TagClientKeyStart, pos, pos + 1);
            pos++;
            if (pos >= end) return finish(pos);
            if (pos > tagDataLimitPos) {
              throw new LimitExceededError("tagDataLimit", tagDataLimit, pos, lastTok());
            }
          }
          const tokenStart = pos;
          if (isTagKeyChar(buffer[pos]!)) {
            pos++;
            for (;; pos++) {
              if (pos >= end) {
                emit(T_TagKey, tokenStart, pos);
                return finish(pos);
              }
              if (pos > tagDataLimitPos) {
                throw new LimitExceededError("tagDataLimit", tagDataLimit, pos, lastTok());
              }
              if (!isTagKeyChar(buffer[pos]!)) break;
            }
            emit(T_TagKey, tokenStart, pos);
          }
        }

        // TagValueStart
        if (buffer[pos] === CHAR_EQUALS) {
          emit(T_TagValueStart, pos, pos + 1);
          pos++;
          if (pos >= end) {
            emit(T_TagValue, pos, pos);
            return finish(pos);
          }
          if (pos > tagDataLimitPos) {
            throw new LimitExceededError("tagDataLimit", tagDataLimit, pos, lastTok());
          }
          // TagValue
          {
            const tokenStart = pos;
            if (isTagValueChar(buffer[pos]!)) {
              pos++;
              for (;; pos++) {
                if (pos >= end) {
                  emit(T_TagValue, tokenStart, pos);
                  return finish(pos);
                }
                if (pos > tagDataLimitPos) {
                  throw new LimitExceededError("tagDataLimit", tagDataLimit, pos, lastTok());
                }
                if (!isTagValueChar(buffer[pos]!)) break;
              }
            }
            emit(T_TagValue, tokenStart, pos);
          }
        }
        tagCount++;

        // TagSeparator or Separator
        {
          const c = buffer[pos]!;
          if (c === CHAR_SEMICOLON) {
            emit(T_TagSeparator, pos, pos + 1);
            pos++;
            if (pos >= end) return finish(pos);
            if (pos > tagDataLimitPos) {
              throw new LimitExceededError("tagDataLimit", tagDataLimit, pos, lastTok());
            }
            continue; // :TAG
          }
          if (c === CHAR_SPACE) {
            const tokenStart = pos;
            pos++;
            for (;; pos++) {
              if (pos >= end) {
                emit(T_Separator, tokenStart, pos);
                return finish(pos);
              }
              if (pos > tagDataLimitPos) {
                emit(T_Separator, tokenStart, pos);
                throw new LimitExceededError("tagDataLimit", tagDataLimit, pos, lastTok());
              }
              if (buffer[pos] !== CHAR_SPACE) break;
            }
            emit(T_Separator, tokenStart, pos);
            break; // :TAG
          }
          // we should never reach this
          throw new UnexpectedCharAssertionError(pos, c, lastTok());
        }
      }
    }

    // RFC 1459 portion length check (prefix + command + params).
    if (end - pos > rfc1459DataLimit) {
      throw new LimitExceededError("rfc1459DataLimit", rfc1459DataLimit, pos, lastTok());
    }

    // prefix
    if (buffer[pos] === CHAR_COLON) {
      emit(T_PrefixStart, pos, pos + 1);
      pos++;
      if (pos >= end) return finish(pos);

      // PrefixName
      {
        const tokenStart = pos;
        while (pos < end && isPrefixNameChar(buffer[pos]!)) pos++;
        if (pos > tokenStart) emit(T_PrefixName, tokenStart, pos);
        if (pos >= end) return finish(pos);
      }

      // PrefixUserStart
      if (buffer[pos] === CHAR_EXCL) {
        emit(T_PrefixUserStart, pos, pos + 1);
        pos++;
        if (pos >= end) return finish(pos);
        // PrefixUser
        {
          const tokenStart = pos;
          while (pos < end && isPrefixUserChar(buffer[pos]!)) pos++;
          if (pos > tokenStart) emit(T_PrefixUser, tokenStart, pos);
          if (pos >= end) return finish(pos);
        }
      }

      // PrefixHostStart
      if (buffer[pos] === CHAR_AT) {
        emit(T_PrefixHostStart, pos, pos + 1);
        pos++;
        if (pos >= end) return finish(pos);
        // PrefixHost
        {
          const tokenStart = pos;
          while (pos < end && buffer[pos] !== CHAR_SPACE) pos++;
          if (pos > tokenStart) emit(T_PrefixHost, tokenStart, pos);
          if (pos >= end) return finish(pos);
        }
      }

      if (buffer[pos] === CHAR_SPACE) {
        const tokenStart = pos;
        pos++;
        while (pos < end && buffer[pos] === CHAR_SPACE) pos++;
        emit(T_Separator, tokenStart, pos);
        if (pos >= end) return finish(pos);
      } else {
        // we should never reach this
        throw new UnexpectedCharAssertionError(pos, buffer[pos]!, lastTok());
      }
    }

    // Command
    {
      const tokenStart = pos;
      while (pos < end && buffer[pos] !== CHAR_SPACE) pos++;
      emit(T_Command, tokenStart, pos);
      if (pos >= end) return finish(pos);
    }

    // Separator
    {
      const tokenStart = pos;
      while (pos < end && buffer[pos] === CHAR_SPACE) pos++;
      emit(T_Separator, tokenStart, pos);
      if (pos >= end) return finish(pos);
    }

    // Parameters
    let paramCount = 0;
    while (true) {
      if (paramCount >= paramCountLimit) {
        throw new LimitExceededError("paramCountLimit", paramCountLimit, pos, lastTok());
      }
      paramCount++;
      // TrailingParameterStart and TrailingParameter
      if (buffer[pos] === CHAR_COLON) {
        emit(T_TrailingParameterStart, pos, pos + 1);
        emit(T_TrailingParameter, pos + 1, end);
        return finish(end);
      }
      // MiddleParameter
      {
        const tokenStart = pos;
        while (pos < end && buffer[pos] !== CHAR_SPACE) pos++;
        emit(T_MiddleParameter, tokenStart, pos);
        if (pos >= end) return finish(pos);
      }

      // Separator
      {
        const tokenStart = pos;
        while (pos < end && buffer[pos] === CHAR_SPACE) pos++;
        emit(T_Separator, tokenStart, pos);
        if (pos >= end) return finish(pos);
      }
    }
  }

  /** Tokenize and return an owned copy of the triples. */
  public tokenize(buffer: Uint8Array, start = 0, end = buffer.length): TokenArray {
    const count = this.tokenizeInto(buffer, start, end);
    return { tokens: this.scratch.slice(0, count * 3), count };
  }
}
