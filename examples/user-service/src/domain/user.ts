export interface User {
  readonly id: number;
  readonly name: string;
  readonly email: string;
  readonly createdAt: string;
}

/**
 * Request body for creating a user. `amoxi build` generates a validator from this type
 * (including the JSDoc constraints), and only these properties reach the controller.
 */
export interface NewUser {
  /**
   * @minLength 1
   * @maxLength 80
   * @pattern \S
   * @patternMessage must not be blank
   */
  readonly name: string;
  /**
   * @format email
   * @maxLength 254
   */
  readonly email: string;
}
