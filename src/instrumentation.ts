/**
 * instrumentation.ts — הדמון-נלווה: השרשרת קמה עם-השרת (מורשת guardian_boot).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureChain } = await import("@/lib/dex/chain");
    ensureChain();
  }
}
