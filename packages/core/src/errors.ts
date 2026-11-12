/** 引擎拒绝某个操作时抛出；message 面向用户，code 便于程序判断 */
export class ForgeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ForgeError';
    this.code = code;
  }
}
