import { Token, EOF, TagsStart, TagClientKeyStart, TagKey, TagValueStart, TagValue, TagSeparator, Separator, PrefixStart, PrefixName, PrefixUserStart, PrefixUser, PrefixHostStart, PrefixHost, Command, TrailingParameterStart, TrailingParameter, MiddleParameter } from './Token'
import { CHAR_AT, CHAR_SPACE, CHAR_PLUS, CHAR_EQUALS, CHAR_SEMICOLON, CHAR_COLON, CHAR_EXCL, isTagKeyChar, isTagValueChar, isPrefixNameChar, isPrefixUserChar } from './chars'
import { LimitExceededError, UnexpectedCharAssertionError } from './errors'

const eof = (tokens: Token[], pos: number) => {
  tokens.push(new EOF(pos))
  return tokens
}

const last = <T>(array: T[]) => array[array.length - 1]

export interface TokenizerOptions {
  tagDataLimit?: number;
  tagCountLimit?: number;
  rfc1459DataLimit?: number;
  paramCountLimit?: number;
}

interface BufferInterface {
  readonly [index: number]: number;
  readonly length: number;
}

export class Tokenizer {
  // IRCv3 message-tags: the tag section is limited to 8191 bytes, including the
  // leading '@' and the trailing space — exactly what this byte count spans.
  public tagDataLimit = 8191;
  public tagCountLimit = 1000;
  // RFC 1459 §2.3 / RFC 2812 §2.3: 512 bytes including CR-LF, i.e. 510 bytes
  // for the prefix + command + params (the line we tokenize has no CR-LF).
  public rfc1459DataLimit = 510;
  public paramCountLimit = 200;

  constructor (options: TokenizerOptions = {}) {
    this.setOptions(options);
  }

  /**
   * @param {TokenizerOptions} options
   */
  setOptions (options: TokenizerOptions) {
    if (options !== null && (typeof options === 'object' || typeof options === 'function')) {
      if (typeof options.tagDataLimit === 'number') {
        this.tagDataLimit = options.tagDataLimit >>> 0
      }
      if (typeof options.tagCountLimit === 'number') {
        this.tagCountLimit = options.tagCountLimit >>> 0
      }
      if (typeof options.rfc1459DataLimit === 'number') {
        this.rfc1459DataLimit = options.rfc1459DataLimit >>> 0
      }
      if (typeof options.paramCountLimit === 'number') {
        this.paramCountLimit = options.paramCountLimit >>> 0
      }
    }
  }


  public tokenize (buffer: BufferInterface, start = 0, end = buffer.length) {
    start = Math.max(0, start) >>> 0
    end = Math.min(buffer.length, end) >>> 0

    const tagDataLimit = this.tagDataLimit >>> 0
    const tagCountLimit = this.tagCountLimit >>> 0
    const rfc1459DataLimit = this.rfc1459DataLimit >>> 0
    const paramCountLimit = this.paramCountLimit >>> 0

    /**
     * @type {Tokenizer.Token[]}
     */
    const tokens: Token[] = []
    let pos = start >>> 0
    if ((end - start) === 0) {
      return eof(tokens, pos)
    }

    // clean leading spaces
    for (;; pos++) {
      if (pos >= end) return eof(tokens, pos)
      if (buffer[pos] !== CHAR_SPACE) break
    }

    // message tags
    if (buffer[pos] === CHAR_AT) {
      const tagDataLimitPos = pos + tagDataLimit
      let tagCount = 0

      if (tagDataLimit === 0) {
        throw new LimitExceededError('tagDataLimit', tagDataLimit, pos, last(tokens))
      }
      tokens.push(new TagsStart(pos))
      pos++
      if (pos >= end) return eof(tokens, pos)

      if (pos > tagDataLimitPos) {
        throw new LimitExceededError('tagDataLimit', tagDataLimit, pos, last(tokens))
      }
      // TAG:
      for (;;) {
        if (tagCount >= tagCountLimit) {
          throw new LimitExceededError('tagCountLimit', tagCountLimit, pos, last(tokens))
        }
        // TagKey
        {
          if (buffer[pos] === CHAR_PLUS) {
            tokens.push(new TagClientKeyStart(pos))
            pos++
            // Enforce the limit before accepting at EOF, or a boundary-length
            // tag section that ends the message is wrongly accepted.
            if (pos > tagDataLimitPos) {
              throw new LimitExceededError('tagDataLimit', tagDataLimit, pos, last(tokens))
            }
            if (pos >= end) return eof(tokens, pos)
          }
          const tokenStart = pos
          if (isTagKeyChar(buffer[pos]!)) {
            pos++
            for (;; pos++) {
              if (pos > tagDataLimitPos) {
                throw new LimitExceededError('tagDataLimit', tagDataLimit, pos, last(tokens))
              }
              if (pos >= end) {
                tokens.push(new TagKey(tokenStart, pos))
                return eof(tokens, pos)
              }
              if (!isTagKeyChar(buffer[pos]!)) break
            }
            tokens.push(new TagKey(tokenStart, pos))
          }
        }

        // TagValueStart
        if (buffer[pos] === CHAR_EQUALS) {
          tokens.push(new TagValueStart(pos))
          pos++
          if (pos > tagDataLimitPos) {
            throw new LimitExceededError('tagDataLimit', tagDataLimit, pos, last(tokens))
          }
          if (pos >= end) {
            tokens.push(new TagValue(pos, pos))
            return eof(tokens, pos)
          }
          // TagValue
          {
            const tokenStart = pos
            if (isTagValueChar(buffer[pos]!)) {
              pos++
              for (;; pos++) {
                if (pos > tagDataLimitPos) {
                  throw new LimitExceededError('tagDataLimit', tagDataLimit, pos, last(tokens))
                }
                if (pos >= end) {
                  tokens.push(new TagValue(tokenStart, pos))
                  return eof(tokens, pos)
                }

                if (!isTagValueChar(buffer[pos]!)) break
              }
            }
            tokens.push(new TagValue(tokenStart, pos))
          }
        }
        tagCount++

        // TagSeparator or Separator
        {
          const c = buffer[pos]!
          if (c === CHAR_SEMICOLON) {
            tokens.push(new TagSeparator(pos))
            pos++
            if (pos >= end) {
              return eof(tokens, pos)
            }
            if (pos > tagDataLimitPos) {
              throw new LimitExceededError('tagDataLimit', tagDataLimit, pos, last(tokens))
            }
            continue // :TAG
          }
          if (c === CHAR_SPACE) {
            const tokenStart = pos
            pos++
            for (;; pos++) {
              if (pos >= end) {
                tokens.push(new Separator(tokenStart, pos))
                return eof(tokens, pos)
              }
              if (pos > tagDataLimitPos) {
                tokens.push(new Separator(tokenStart, pos))
                throw new LimitExceededError('tagDataLimit', tagDataLimit, pos, last(tokens))
              }
              if (buffer[pos] !== CHAR_SPACE) break
            }
            tokens.push(new Separator(tokenStart, pos))
            break // :TAG
          }
          // we should never reach this
          throw new UnexpectedCharAssertionError(pos, c, last(tokens))
        }
      }
    }

    // RFC 1459 portion (prefix + command + parameters). It runs contiguously
    // to `end`, so its byte length is exactly `end - pos` here — a single check
    // suffices and lets us reject an oversized message before scanning it. The
    // tag section is intentionally excluded from this limit.
    if ((end - pos) > rfc1459DataLimit) {
      throw new LimitExceededError('rfc1459DataLimit', rfc1459DataLimit, pos, last(tokens))
    }

    // prefix
    if (buffer[pos] === CHAR_COLON) {
      tokens.push(new PrefixStart(pos, pos + 1))
      pos++
      if (pos >= end) {
        return eof(tokens, pos)
      }

      // PrefixName
      {
        const tokenStart = pos
        while (pos < end && isPrefixNameChar(buffer[pos]!)) pos++
        if (pos > tokenStart) {
          tokens.push(new PrefixName(tokenStart, pos))
        }
        if (pos >= end) {
          return eof(tokens, pos)
        }
      }

      // PrefixUserStart
      if (buffer[pos] === CHAR_EXCL) {
        tokens.push(new PrefixUserStart(pos, pos + 1))
        pos++
        if (pos >= end) {
          return eof(tokens, pos)
        }
        // PrefixUser
        {
          const tokenStart = pos
          while (pos < end && isPrefixUserChar(buffer[pos]!)) pos++
          if (pos > tokenStart) {
            tokens.push(new PrefixUser(tokenStart, pos))
          }
          if (pos >= end) {
            return eof(tokens, pos)
          }
        }
      }

      // PrefixHostStart
      if (buffer[pos] === CHAR_AT) {
        tokens.push(new PrefixHostStart(pos, pos + 1))
        pos++
        if (pos >= end) {
          return eof(tokens, pos)
        }
        // PrefixHost
        {
          const tokenStart = pos
          while (pos < end && buffer[pos] !== CHAR_SPACE) pos++
          if (pos > tokenStart) {
            tokens.push(new PrefixHost(tokenStart, pos))
          }
          if (pos >= end) {
            return eof(tokens, pos)
          }
        }
      }

      if (buffer[pos] === CHAR_SPACE) {
        const tokenStart = pos
        pos++
        while (pos < end && buffer[pos] === CHAR_SPACE) pos++
        tokens.push(new Separator(tokenStart, pos))
        if (pos >= end) {
          return eof(tokens, pos)
        }
      } else {
        // we should never reach this
        throw new UnexpectedCharAssertionError(pos, buffer[pos]!, last(tokens))
      }
    }

    // Command
    {
      const tokenStart = pos
      while (pos < end && buffer[pos] !== CHAR_SPACE) pos++
      tokens.push(new Command(tokenStart, pos))
      if (pos >= end) {
        return eof(tokens, pos)
      }
    }

    // Separator
    {
      const tokenStart = pos
      while (pos < end && buffer[pos] === CHAR_SPACE) pos++
      tokens.push(new Separator(tokenStart, pos))
      if (pos >= end) {
        return eof(tokens, pos)
      }
    }

    // Parameters
    let paramCount = 0
    while (true) {
      if (paramCount >= paramCountLimit) {
        throw new LimitExceededError('paramCountLimit', paramCountLimit, pos, last(tokens))
      }
      paramCount++
      // TrailingParameterStart and TrailingParameter
      if (buffer[pos] === CHAR_COLON) {
        tokens.push(new TrailingParameterStart(pos))
        tokens.push(new TrailingParameter(pos + 1, end))
        return eof(tokens, end)
      }
      // MiddleParameter
      {
        const tokenStart = pos
        while (pos < end && buffer[pos] !== CHAR_SPACE) pos++
        tokens.push(new MiddleParameter(tokenStart, pos))
        if (pos >= end) {
          return eof(tokens, pos)
        }
      }

      // Separator
      {
        const tokenStart = pos
        while (pos < end && buffer[pos] === CHAR_SPACE) pos++
        tokens.push(new Separator(tokenStart, pos))
        if (pos >= end) {
          return eof(tokens, pos)
        }
      }
    }
  }
}