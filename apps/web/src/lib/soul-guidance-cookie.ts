/** Single-use carrier for one guidance result. Kept out of the `"use server"` module, which may only
 * export async functions, and read+cleared by the Soul page on its next render. */
export const GUIDANCE_COOKIE = 'qx-soul-guidance';
