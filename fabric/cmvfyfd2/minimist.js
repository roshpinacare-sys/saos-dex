const { parseArgs } = require('node:util');

// דוגמה להחלפת minimist ב-parse-args
const minimist = require('minimist');

// קוד ישן עם minimist (לפני התיקון)
const oldArgs = minimist(process.argv.slice(2));
console.log('ישן:', oldArgs);

// קוד חדש עם parse-args (אחרי התיקון)
const newArgs = parseArgs({
  args: process.argv.slice(2),
  options: {
    foo: { type: 'string', short: 'f' },
    bar: { type: 'boolean', short: 'b' },
    number: { type: 'number' },
  },
});
console.log('חדש:', newArgs);

// פונקציה להחלפת כל השימוש ב-minimist בפרויקט
function replaceMinimistWithParseArgs(code) {
  // מציאת כל הקריאות ל-minimist
  const minimistRegex = /require\(['"]minimist['"]\)/g;
  
  // החלפה ב-require של parse-args מ-node:util
  const replacedCode = code.replace(minimistRegex, "const { parseArgs } = require('node:util');");
  
  // מציאה של קריאות ל-minimist() והחלפה ב-parseArgs
  const minimistCallRegex = /minimist\(([^)]+)\)/g;
  const finalCode = replacedCode.replace(minimistCallRegex, (match, args) => {
    // בדיקה אם יש אופציות מורכבות
    if (args.includes('{')) {
      // אם כבר יש אובייקט אופציות, נשתמש בו ישירות
      return `parseArgs(${args})`;
    } else {
      // אם יש רק מערך ארגומנטים, נגדיר אופציות בסיסיות
      return `parseArgs({ args: ${args} })`;
    }
  });
  
  return finalCode;
}