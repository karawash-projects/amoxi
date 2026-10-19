export interface Note {
  readonly id: number;
  readonly text: string;
  readonly createdAt: string;
}

/**
 * Body of `POST /api/notes`. Amoxi generates a validator from this type at build time,
 * including the JSDoc rules below, and strips any other properties.
 */
export interface NewNote {
  /**
   * @minLength 1
   * @maxLength 280
   * @pattern \S
   * @patternMessage must not be blank
   */
  readonly text: string;
}
