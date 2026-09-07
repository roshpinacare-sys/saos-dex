/**
 * evidence-port.ts — יציאת-עדויות סטנדרטית לחבילת-הביקורת (standalone port).
 *
 * SECURITY INTENT / היקף: בקוד-הייצור, עדויות השרשרת (blockHeader / sealRecord /
 * evidenceReceipt) נשמרות ב-Prisma+SQLite דרך `@/lib/db`. שכבת-הנתונים אינה
 * חלק מהיקף-הביקורת — היא אחסון-ראיות בלבד, מחוץ-לנתיב-הקונצנזוס: כל-כתיבה
 * ב-chain.ts עטופה try/catch, כשל-DB מסומן dbOk לתצפית, ואינו מפיל את
 * השרשרת ואינו משפיע על stateRoot / מרקל / עיגון.
 *
 * הפורט הזה מממש את אותו-שטח-קריאה בדיוק (no-op, בלי I/O) כך ש-chain.ts
 * בחבילה זהה-לייצור פרט-לשורת-ייבוא אחת (ראה FIDELITY.diff). צוות-הביקורת
 * מוזמן לאמת שאף-נתיב-קונצנזוס אינו תלוי בערך-החזרה מהפורט.
 */
export const db = {
  blockHeader: {
    create: (_a: unknown): Promise<never> => Promise.reject(new Error("evidence-port: storage disabled in audit package (non-blocking in chain.ts)")),
    deleteMany: (_a?: unknown): Promise<{ count: number }> => Promise.resolve({ count: 0 }),
  },
  sealRecord: {
    create: (_a: unknown): Promise<never> => Promise.reject(new Error("evidence-port: storage disabled in audit package (non-blocking in chain.ts)")),
    deleteMany: (_a?: unknown): Promise<{ count: number }> => Promise.resolve({ count: 0 }),
  },
  evidenceReceipt: {
    create: (_a: unknown): Promise<never> => Promise.reject(new Error("evidence-port: storage disabled in audit package (non-blocking in chain.ts)")),
    deleteMany: (_a?: unknown): Promise<{ count: number }> => Promise.resolve({ count: 0 }),
  },
  arenaJournal: {
    deleteMany: (_a?: unknown): Promise<{ count: number }> => Promise.resolve({ count: 0 }),
  },
};
