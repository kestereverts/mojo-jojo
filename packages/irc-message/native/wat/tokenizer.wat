;; Hand-written IRC tokenizer in WebAssembly text format.
;;
;; A byte-for-byte port of the reference state machine (see Tokenizer.ts /
;; JsFastTokenizer.ts). Reads `inLen` bytes at `inPtr` and writes `[type,
;; start, end]` int32 triples at `outPtr`, returning the token count.
;;
;; ABI:
;;   tokenize(inPtr, inLen, outPtr, outCap,
;;            tagDataLimit, tagCountLimit, rfc1459DataLimit, paramCountLimit) -> i32
;;     >= 0 : token count; triples written at outPtr (count*3 i32s).
;;     <  0 : error. The first two i32 slots at outPtr hold [errPos, errChar].
;;            -1 tagDataLimit  -2 tagCountLimit  -3 rfc1459DataLimit
;;            -4 paramCountLimit  -5 unexpected char.
;;
;; Token type numbers match the TokenType enum:
;;   0 EOF              1 TagsStart        2 TagClientKeyStart 3 TagKey
;;   4 TagValueStart    5 TagValue         6 TagSeparator      7 PrefixStart
;;   8 PrefixName       9 PrefixUserStart 10 PrefixUser       11 PrefixHostStart
;;  12 PrefixHost      13 Separator       14 Command          15 MiddleParameter
;;  16 TrailingParameterStart            17 TrailingParameter
;;
;; Byte constants: '@'=64 ' '=32 '+'=43 '='=61 ';'=59 ':'=58 '!'=33

(module
  (memory (export "memory") 1)

  (global $j (mut i32) (i32.const 0))        ;; output write cursor (i32 slots)
  (global $outBase (mut i32) (i32.const 0))
  (global $inBase (mut i32) (i32.const 0))

  ;; read input byte at offset i
  (func $byte (param $i i32) (result i32)
    (i32.load8_u (i32.add (global.get $inBase) (local.get $i))))

  ;; write a [type,start,end] triple and advance the cursor
  (func $emit (param $t i32) (param $s i32) (param $e i32)
    (local $a i32)
    (local.set $a (i32.add (global.get $outBase)
                           (i32.mul (global.get $j) (i32.const 4))))
    (i32.store (local.get $a) (local.get $t))
    (i32.store offset=4 (local.get $a) (local.get $s))
    (i32.store offset=8 (local.get $a) (local.get $e))
    (global.set $j (i32.add (global.get $j) (i32.const 3))))

  ;; emit EOF at p and return the token count
  (func $finishval (param $p i32) (result i32)
    (call $emit (i32.const 0) (local.get $p) (local.get $p))
    (i32.div_u (global.get $j) (i32.const 3)))

  ;; write [errPos,errChar] at outBase and return the (negative) code
  (func $errAt (param $pos i32) (param $char i32) (param $code i32) (result i32)
    (i32.store (global.get $outBase) (local.get $pos))
    (i32.store offset=4 (global.get $outBase) (local.get $char))
    (local.get $code))

  (func (export "tokenize")
    (param $inPtr i32) (param $inLen i32) (param $outPtr i32) (param $outCap i32)
    (param $tagDataLimit i32) (param $tagCountLimit i32)
    (param $rfc1459DataLimit i32) (param $paramCountLimit i32)
    (result i32)
    (local $pos i32) (local $end i32) (local $c i32) (local $tokenStart i32)
    (local $tagDataLimitPos i32) (local $tagCount i32) (local $paramCount i32)

    (global.set $inBase (local.get $inPtr))
    (global.set $outBase (local.get $outPtr))
    (global.set $j (i32.const 0))
    (local.set $end (local.get $inLen))
    (local.set $pos (i32.const 0))

    ;; empty input
    (if (i32.eqz (local.get $inLen))
      (then (return (call $finishval (i32.const 0)))))

    ;; clean leading spaces
    (block $afterLeading
      (loop $leading
        (if (i32.ge_u (local.get $pos) (local.get $end))
          (then (return (call $finishval (local.get $pos)))))
        (br_if $afterLeading
          (i32.ne (call $byte (local.get $pos)) (i32.const 32)))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
        (br $leading)))

    ;; ===== message tags =====
    (if (i32.eq (call $byte (local.get $pos)) (i32.const 64))  ;; '@'
      (then
        (local.set $tagDataLimitPos
          (i32.add (local.get $pos) (local.get $tagDataLimit)))
        (local.set $tagCount (i32.const 0))
        (if (i32.eqz (local.get $tagDataLimit))
          (then (return (call $errAt (local.get $pos) (i32.const 0) (i32.const -1)))))
        (call $emit (i32.const 1) (local.get $pos)
                    (i32.add (local.get $pos) (i32.const 1)))  ;; TagsStart
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
        (if (i32.ge_u (local.get $pos) (local.get $end))
          (then (return (call $finishval (local.get $pos)))))
        (if (i32.gt_u (local.get $pos) (local.get $tagDataLimitPos))
          (then (return (call $errAt (local.get $pos) (i32.const 0) (i32.const -1)))))

        (block $tagLoopEnd
          (loop $tagLoop
            (if (i32.ge_u (local.get $tagCount) (local.get $tagCountLimit))
              (then (return (call $errAt (local.get $pos) (i32.const 0) (i32.const -2)))))

            ;; ---- TagKey (with optional '+' client prefix) ----
            (if (i32.eq (call $byte (local.get $pos)) (i32.const 43))  ;; '+'
              (then
                (call $emit (i32.const 2) (local.get $pos)
                            (i32.add (local.get $pos) (i32.const 1)))  ;; TagClientKeyStart
                (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
                (if (i32.ge_u (local.get $pos) (local.get $end))
                  (then (return (call $finishval (local.get $pos)))))
                (if (i32.gt_u (local.get $pos) (local.get $tagDataLimitPos))
                  (then (return (call $errAt (local.get $pos) (i32.const 0) (i32.const -1)))))))
            (local.set $tokenStart (local.get $pos))
            (local.set $c (call $byte (local.get $pos)))
            (if (i32.and (i32.and (i32.ne (local.get $c) (i32.const 61))
                                  (i32.ne (local.get $c) (i32.const 32)))
                         (i32.ne (local.get $c) (i32.const 59)))  ;; isTagKeyChar
              (then
                (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
                (block $kb
                  (loop $kl
                    (if (i32.ge_u (local.get $pos) (local.get $end))
                      (then (call $emit (i32.const 3) (local.get $tokenStart) (local.get $pos))
                            (return (call $finishval (local.get $pos)))))
                    (if (i32.gt_u (local.get $pos) (local.get $tagDataLimitPos))
                      (then (return (call $errAt (local.get $pos) (i32.const 0) (i32.const -1)))))
                    (local.set $c (call $byte (local.get $pos)))
                    (br_if $kb (i32.eq (local.get $c) (i32.const 61)))
                    (br_if $kb (i32.eq (local.get $c) (i32.const 32)))
                    (br_if $kb (i32.eq (local.get $c) (i32.const 59)))
                    (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
                    (br $kl)))
                (call $emit (i32.const 3) (local.get $tokenStart) (local.get $pos))))  ;; TagKey

            ;; ---- TagValueStart / TagValue ----
            (if (i32.eq (call $byte (local.get $pos)) (i32.const 61))  ;; '='
              (then
                (call $emit (i32.const 4) (local.get $pos)
                            (i32.add (local.get $pos) (i32.const 1)))  ;; TagValueStart
                (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
                (if (i32.ge_u (local.get $pos) (local.get $end))
                  (then
                    (call $emit (i32.const 5) (local.get $pos) (local.get $pos))  ;; empty TagValue
                    (return (call $finishval (local.get $pos)))))
                (if (i32.gt_u (local.get $pos) (local.get $tagDataLimitPos))
                  (then (return (call $errAt (local.get $pos) (i32.const 0) (i32.const -1)))))
                (local.set $tokenStart (local.get $pos))
                (local.set $c (call $byte (local.get $pos)))
                (if (i32.and (i32.ne (local.get $c) (i32.const 32))
                             (i32.ne (local.get $c) (i32.const 59)))  ;; isTagValueChar
                  (then
                    (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
                    (block $vb
                      (loop $vl
                        (if (i32.ge_u (local.get $pos) (local.get $end))
                          (then (call $emit (i32.const 5) (local.get $tokenStart) (local.get $pos))
                                (return (call $finishval (local.get $pos)))))
                        (if (i32.gt_u (local.get $pos) (local.get $tagDataLimitPos))
                          (then (return (call $errAt (local.get $pos) (i32.const 0) (i32.const -1)))))
                        (local.set $c (call $byte (local.get $pos)))
                        (br_if $vb (i32.eq (local.get $c) (i32.const 32)))
                        (br_if $vb (i32.eq (local.get $c) (i32.const 59)))
                        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
                        (br $vl)))))
                (call $emit (i32.const 5) (local.get $tokenStart) (local.get $pos))))  ;; TagValue

            (local.set $tagCount (i32.add (local.get $tagCount) (i32.const 1)))

            ;; ---- TagSeparator (';') or end-of-tags Separator (' ') ----
            (local.set $c (call $byte (local.get $pos)))
            (if (i32.eq (local.get $c) (i32.const 59))  ;; ';'
              (then
                (call $emit (i32.const 6) (local.get $pos)
                            (i32.add (local.get $pos) (i32.const 1)))  ;; TagSeparator
                (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
                (if (i32.ge_u (local.get $pos) (local.get $end))
                  (then (return (call $finishval (local.get $pos)))))
                (if (i32.gt_u (local.get $pos) (local.get $tagDataLimitPos))
                  (then (return (call $errAt (local.get $pos) (i32.const 0) (i32.const -1)))))
                (br $tagLoop)))
            (if (i32.eq (local.get $c) (i32.const 32))  ;; ' '
              (then
                (local.set $tokenStart (local.get $pos))
                (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
                (block $sb
                  (loop $sl
                    (if (i32.ge_u (local.get $pos) (local.get $end))
                      (then (call $emit (i32.const 13) (local.get $tokenStart) (local.get $pos))
                            (return (call $finishval (local.get $pos)))))
                    (if (i32.gt_u (local.get $pos) (local.get $tagDataLimitPos))
                      (then (call $emit (i32.const 13) (local.get $tokenStart) (local.get $pos))
                            (return (call $errAt (local.get $pos) (i32.const 0) (i32.const -1)))))
                    (br_if $sb (i32.ne (call $byte (local.get $pos)) (i32.const 32)))
                    (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
                    (br $sl)))
                (call $emit (i32.const 13) (local.get $tokenStart) (local.get $pos))  ;; Separator
                (br $tagLoopEnd)))
            ;; unexpected char
            (return (call $errAt (local.get $pos) (local.get $c) (i32.const -5)))))))

    ;; ===== RFC1459 portion length =====
    (if (i32.gt_u (i32.sub (local.get $end) (local.get $pos)) (local.get $rfc1459DataLimit))
      (then (return (call $errAt (local.get $pos) (i32.const 0) (i32.const -3)))))

    ;; ===== prefix =====
    (if (i32.eq (call $byte (local.get $pos)) (i32.const 58))  ;; ':'
      (then
        (call $emit (i32.const 7) (local.get $pos)
                    (i32.add (local.get $pos) (i32.const 1)))  ;; PrefixStart
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
        (if (i32.ge_u (local.get $pos) (local.get $end))
          (then (return (call $finishval (local.get $pos)))))

        ;; PrefixName
        (local.set $tokenStart (local.get $pos))
        (block $pnb
          (loop $pnl
            (br_if $pnb (i32.ge_u (local.get $pos) (local.get $end)))
            (local.set $c (call $byte (local.get $pos)))
            (br_if $pnb (i32.eq (local.get $c) (i32.const 32)))
            (br_if $pnb (i32.eq (local.get $c) (i32.const 64)))
            (br_if $pnb (i32.eq (local.get $c) (i32.const 33)))
            (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
            (br $pnl)))
        (if (i32.gt_u (local.get $pos) (local.get $tokenStart))
          (then (call $emit (i32.const 8) (local.get $tokenStart) (local.get $pos))))  ;; PrefixName
        (if (i32.ge_u (local.get $pos) (local.get $end))
          (then (return (call $finishval (local.get $pos)))))

        ;; PrefixUserStart / PrefixUser
        (if (i32.eq (call $byte (local.get $pos)) (i32.const 33))  ;; '!'
          (then
            (call $emit (i32.const 9) (local.get $pos)
                        (i32.add (local.get $pos) (i32.const 1)))  ;; PrefixUserStart
            (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
            (if (i32.ge_u (local.get $pos) (local.get $end))
              (then (return (call $finishval (local.get $pos)))))
            (local.set $tokenStart (local.get $pos))
            (block $pub
              (loop $pul
                (br_if $pub (i32.ge_u (local.get $pos) (local.get $end)))
                (local.set $c (call $byte (local.get $pos)))
                (br_if $pub (i32.eq (local.get $c) (i32.const 32)))
                (br_if $pub (i32.eq (local.get $c) (i32.const 64)))
                (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
                (br $pul)))
            (if (i32.gt_u (local.get $pos) (local.get $tokenStart))
              (then (call $emit (i32.const 10) (local.get $tokenStart) (local.get $pos))))  ;; PrefixUser
            (if (i32.ge_u (local.get $pos) (local.get $end))
              (then (return (call $finishval (local.get $pos)))))))

        ;; PrefixHostStart / PrefixHost
        (if (i32.eq (call $byte (local.get $pos)) (i32.const 64))  ;; '@'
          (then
            (call $emit (i32.const 11) (local.get $pos)
                        (i32.add (local.get $pos) (i32.const 1)))  ;; PrefixHostStart
            (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
            (if (i32.ge_u (local.get $pos) (local.get $end))
              (then (return (call $finishval (local.get $pos)))))
            (local.set $tokenStart (local.get $pos))
            (block $phb
              (loop $phl
                (br_if $phb (i32.ge_u (local.get $pos) (local.get $end)))
                (br_if $phb (i32.eq (call $byte (local.get $pos)) (i32.const 32)))
                (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
                (br $phl)))
            (if (i32.gt_u (local.get $pos) (local.get $tokenStart))
              (then (call $emit (i32.const 12) (local.get $tokenStart) (local.get $pos))))  ;; PrefixHost
            (if (i32.ge_u (local.get $pos) (local.get $end))
              (then (return (call $finishval (local.get $pos)))))))

        ;; trailing separator after prefix
        (if (i32.eq (call $byte (local.get $pos)) (i32.const 32))
          (then
            (local.set $tokenStart (local.get $pos))
            (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
            (block $psb
              (loop $psl
                (br_if $psb (i32.ge_u (local.get $pos) (local.get $end)))
                (br_if $psb (i32.ne (call $byte (local.get $pos)) (i32.const 32)))
                (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
                (br $psl)))
            (call $emit (i32.const 13) (local.get $tokenStart) (local.get $pos))  ;; Separator
            (if (i32.ge_u (local.get $pos) (local.get $end))
              (then (return (call $finishval (local.get $pos))))))
          (else
            (return (call $errAt (local.get $pos) (call $byte (local.get $pos)) (i32.const -5)))))))

    ;; ===== Command =====
    (local.set $tokenStart (local.get $pos))
    (block $cb
      (loop $cl
        (br_if $cb (i32.ge_u (local.get $pos) (local.get $end)))
        (br_if $cb (i32.eq (call $byte (local.get $pos)) (i32.const 32)))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
        (br $cl)))
    (call $emit (i32.const 14) (local.get $tokenStart) (local.get $pos))  ;; Command
    (if (i32.ge_u (local.get $pos) (local.get $end))
      (then (return (call $finishval (local.get $pos)))))

    ;; ===== Separator =====
    (local.set $tokenStart (local.get $pos))
    (block $cs
      (loop $csl
        (br_if $cs (i32.ge_u (local.get $pos) (local.get $end)))
        (br_if $cs (i32.ne (call $byte (local.get $pos)) (i32.const 32)))
        (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
        (br $csl)))
    (call $emit (i32.const 13) (local.get $tokenStart) (local.get $pos))  ;; Separator
    (if (i32.ge_u (local.get $pos) (local.get $end))
      (then (return (call $finishval (local.get $pos)))))

    ;; ===== Parameters =====
    (local.set $paramCount (i32.const 0))
    (loop $params
      (if (i32.ge_u (local.get $paramCount) (local.get $paramCountLimit))
        (then (return (call $errAt (local.get $pos) (i32.const 0) (i32.const -4)))))
      (local.set $paramCount (i32.add (local.get $paramCount) (i32.const 1)))

      ;; Trailing parameter
      (if (i32.eq (call $byte (local.get $pos)) (i32.const 58))  ;; ':'
        (then
          (call $emit (i32.const 16) (local.get $pos)
                      (i32.add (local.get $pos) (i32.const 1)))  ;; TrailingParameterStart
          (call $emit (i32.const 17) (i32.add (local.get $pos) (i32.const 1)) (local.get $end))
          (return (call $finishval (local.get $end)))))

      ;; Middle parameter
      (local.set $tokenStart (local.get $pos))
      (block $mb
        (loop $ml
          (br_if $mb (i32.ge_u (local.get $pos) (local.get $end)))
          (br_if $mb (i32.eq (call $byte (local.get $pos)) (i32.const 32)))
          (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
          (br $ml)))
      (call $emit (i32.const 15) (local.get $tokenStart) (local.get $pos))  ;; MiddleParameter
      (if (i32.ge_u (local.get $pos) (local.get $end))
        (then (return (call $finishval (local.get $pos)))))

      ;; Separator
      (local.set $tokenStart (local.get $pos))
      (block $msb
        (loop $msl
          (br_if $msb (i32.ge_u (local.get $pos) (local.get $end)))
          (br_if $msb (i32.ne (call $byte (local.get $pos)) (i32.const 32)))
          (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
          (br $msl)))
      (call $emit (i32.const 13) (local.get $tokenStart) (local.get $pos))  ;; Separator
      (if (i32.ge_u (local.get $pos) (local.get $end))
        (then (return (call $finishval (local.get $pos)))))
      (br $params))

    ;; unreachable (params loop only exits via return)
    (unreachable))
)
