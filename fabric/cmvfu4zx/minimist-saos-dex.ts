import { parseArgs } from 'node:util';

// החלפת minimist ב-parse-args (Node.js built-in)
// דוגמה לשימוש קיים ב-minimist (היפותטי):
// const minimist = require('minimist');
// const argv = minimist(process.argv.slice(2));

// דוגמה להחלפה עם parse-args:
const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    // הגדרת אופציות עם ערכי ברירת מחדל
    'port': { type: 'string', default: '3000' },
    'host': { type: 'string', default: 'localhost' },
    'verbose': { type: 'boolean', default: false },
    'config': { type: 'string', short: 'c' },
  },
});

// המרת positionals ל-argv כמו ב-minimist
const argv = {
  _: positionals,
  ...values
};

// דוגמה לשימוש בארגומנטים מעובדים
if (argv.verbose) {
  console.log(`Running on ${argv.host}:${argv.port}`);
  if (argv.config) {
    console.log(`Using config file: ${argv.config}`);
  }
}

// פונקציית עזר לטיפול בארגומנטים כמו ב-minimist
function getArg(name: string, defaultValue?: any) {
  return argv[name] !== undefined ? argv[name] : defaultValue;
}

// דוגמה לשימוש בפונקציית העזר
const port = getArg('port', '3000');
const host = getArg('host', 'localhost');

console.log(`Server configured to run on ${host}:${port}`);

// ייצוא לשימוש במקומות אחרים בפרויקט
export { argv, getArg };
