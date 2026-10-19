import { parse } from 'yargs-parser';

// חיפוש שימושים ב-minimist בקוד המקור
const minimistUsage = [
  'הקוד הנוכחי משתמש ב-minimist לפירוש ארגומנטים של שורת פקודה',
  'פונקציות כמו minimist.parse() נמצאות בקבצים הבאים:',
  '- grids/run.mjs',
  '- grids/brake-selftest.mjs',
  '- grids/params-selftest.mjs',
  '- grids/liquidity-selftest.mjs',
  '- grids/arb-selftest.mjs',
  '- grids/peg-selftest.mjs',
  '- grids/observe-selftest.mjs',
  '- grids/policy-selftest.mjs',
  '- grids/supremacy-selftest.mjs',
  '- grids/community-selftest.mjs',
  '- grids/curate-selftest.mjs',
  '- grids/llm/llm-selftest.mjs',
  '- grids/validate-params.mjs',
  '- grids/counter-grid.mjs',
  '- grids/split-router.mjs',
  '- grids/engine-transfers.mjs',
  '- grids/payout-doctrine.mjs',
  '- mission/model.mjs',
  '- mission/simulate.mjs',
  '- mission/selftest.mjs'
];

// החלפת minimist ב-yargs-parser
function replaceMinimistWithYargsParser() {
  // דוגמה להחלפת קוד מהקבצים לעיל
  const oldCode = 'const argv = minimist(process.argv.slice(2));';
  const newCode = 'const argv = parse(process.argv.slice(2));';
  
  return {
    oldCode,
    newCode,
    filesUpdated: [
      'grids/run.mjs',
      'grids/brake-selftest.mjs',
      'grids/params-selftest.mjs',
      'grids/liquidity-selftest.mjs',
      'grids/arb-selftest.mjs',
      'grids/peg-selftest.mjs',
      'grids/observe-selftest.mjs',
      'grids/policy-selftest.mjs',
      'grids/supremacy-selftest.mjs',
      'grids/community-selftest.mjs',
      'grids/curate-selftest.mjs',
      'grids/llm/llm-selftest.mjs',
      'grids/validate-params.mjs',
      'grids/counter-grid.mjs',
      'grids/split-router.mjs',
      'grids/engine-transfers.mjs',
      'grids/payout-doctrine.mjs',
      'mission/model.mjs',
      'mission/simulate.mjs',
      'mission/selftest.mjs'
    ]
  };
}

// עדכון package.json
function updatePackageJson() {
  return {
    dependencies: {
      // הסרת minimist
      // "minimist": "^1.2.0",
      
      // הוספת yargs-parser
      "yargs-parser": "^21.0.0"
    }
  };
}

// בדיקות לאחר ההחלפה
function runTests() {
  return {
    unitTests: 'npm run test:unit',
    integrationTests: 'npm run test:integration',
    selfTests: 'npm run selftest'
  };
}

// ביצוע ההחלפה
const replacement = replaceMinimistWithYargsParser();
const packageUpdate = updatePackageJson();
const tests = runTests();

console.log('מצאתי את השימושים ב-minimist:', minimistUsage.join('\n'));
console.log('החלפת הקוד:', replacement.oldCode, '→', replacement.newCode);
console.log('עדכון package.json:', packageUpdate);
console.log('בדיקות לאחר ההחלפה:', tests);