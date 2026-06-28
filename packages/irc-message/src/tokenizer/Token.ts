export enum TokenType {
  EOF = 0,
  TagsStart,
  TagClientKeyStart,
  TagKey,
  TagValueStart,
  TagValue,
  TagSeparator,
  PrefixStart,
  PrefixName,
  PrefixUserStart,
  PrefixUser,
  PrefixHostStart,
  PrefixHost,
  Separator,
  Command,
  MiddleParameter,
  TrailingParameterStart,
  TrailingParameter,
}

export abstract class Token {
  private static readonly tokens = new Map<TokenType, TokenConstructor>();
  public static readonly type: TokenType;


  public readonly type: TokenType;

  public constructor(
    public readonly start: number,
    public readonly end: number = start + 1
    ) {
      this.type = (this.constructor as TokenConstructor).type;
  }

  public get [Symbol.toStringTag](): string {
    return TokenType[this.type];
  }

  public toString () {
    return `${this[Symbol.toStringTag]}[${this.start}:${this.end}]`
  }

  public static register(type: TokenType, constructor: TokenConstructor) {
    this.tokens.set(type, constructor);
  }

  public static from (obj: {type: TokenType, start: number, end: number}) {
    if (obj === null) {
      throw new TypeError('obj is null')
    }
    if (typeof obj === 'undefined') {
      throw new TypeError('obj is undefined')
    }
    if (!this.tokens.has(obj.type)) {
      throw new TypeError(`Unknown token type ${obj.type}`)
    }

    const constructor = this.tokens.get(obj.type)!;
    return new constructor(obj.start, obj.end);
  }
}

export interface TokenConstructor {
  new (start: number, end?: number): Token;
  type: TokenType;
}

export function Tokenizable() {
  return function<T extends TokenConstructor>(constructor: T): T {
    Token.register(constructor.type, constructor);
    return constructor;
  }
}

@Tokenizable()
export class TagsStart extends Token {
  public static override readonly type = TokenType.TagsStart;
}

@Tokenizable()
export class TagClientKeyStart extends Token {
  public static override readonly type = TokenType.TagClientKeyStart;
}

@Tokenizable()
export class TagKey extends Token {
  public static override readonly type = TokenType.TagKey;
}

@Tokenizable()
export class TagValueStart extends Token {
  public static override readonly type = TokenType.TagValueStart;
}

@Tokenizable()
export class TagValue extends Token {
  public static override readonly type = TokenType.TagValue;
}

@Tokenizable()
export class TagSeparator extends Token {
  public static override readonly type = TokenType.TagSeparator;
}

@Tokenizable()
export class PrefixStart extends Token {
  public static override readonly type = TokenType.PrefixStart;
}

@Tokenizable()
export class PrefixName extends Token {
  public static override readonly type = TokenType.PrefixName;
}

@Tokenizable()
export class PrefixUserStart extends Token {
  public static override readonly type = TokenType.PrefixUserStart;
}

@Tokenizable()
export class PrefixUser extends Token {
  public static override readonly type = TokenType.PrefixUser;
}

@Tokenizable()
export class PrefixHostStart extends Token {
  public static override readonly type = TokenType.PrefixHostStart;
}

@Tokenizable()
export class PrefixHost extends Token {
  public static override readonly type = TokenType.PrefixHost;
}

@Tokenizable()
export class Separator extends Token {
  public static override readonly type = TokenType.Separator;
}

@Tokenizable()
export class Command extends Token {
  public static override readonly type = TokenType.Command;
}

@Tokenizable()
export class MiddleParameter extends Token {
  public static override readonly type = TokenType.MiddleParameter;
}

@Tokenizable()
export class TrailingParameterStart extends Token {
  public static override readonly type = TokenType.TrailingParameterStart;
}

@Tokenizable()
export class TrailingParameter extends Token {
  public static override readonly type = TokenType.TrailingParameter;
}

@Tokenizable()
export class EOF extends Token {
  public static override readonly type = TokenType.EOF;
  constructor (start: number, end: number = start) {
    super(start, end);
  }
}
