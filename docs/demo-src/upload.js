// 文件上传：当前单文件上限 5MB
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export function checkUpload(size) {
  return size <= MAX_UPLOAD_BYTES;
}
