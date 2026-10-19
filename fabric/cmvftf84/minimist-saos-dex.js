const fs = require('fs');
const path = require('path');

// נתיב לקובץ package.json
const packageJsonPath = path.join(__dirname, 'package.json');

// קריאת התוכן הנוכחי של package.json
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

// בדיקה אם minimist קיים ב-dependencies
if (packageJson.dependencies && packageJson.dependencies.minimist) {
    const currentVersion = packageJson.dependencies.minimist;
    
    // הגרסה המומלצת המינימלית (>=1.2.6)
    const minSafeVersion = '1.2.6';
    
    // הגרסה האחרונה והבטוחה (ניתן לעדכן לגרסה האחרונה בפועל)
    const latestSafeVersion = '1.2.8';
    
    // בדיקה אם הגרסה הנוכחית פגיעה
    const isVulnerable = currentVersion.startsWith('^0.') || 
                         currentVersion.startsWith('~0.') ||
                         currentVersion === '*' ||
                         (currentVersion.startsWith('^') && 
                          currentVersion.slice(1).localeCompare(minSafeVersion, undefined, { numeric: true }) < 0);
    
    if (isVulnerable) {
        console.log(`גרסת minimist פגיעה נמצאה: ${currentVersion}`);
        console.log(`מעדכן לגרסה בטוחה: ${latestSafeVersion}`);
        
        // עדכון הגרסה
        packageJson.dependencies.minimist = `^${latestSafeVersion}`;
        
        // שמירת השינויים בקובץ
        fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
        
        console.log('package.json עודכן בהצלחה. יש להריץ npm install כדי להתקין את העדכון.');
    } else {
        console.log(`גרסת minimist כבר בטוחה: ${currentVersion}`);
    }
} else {
    console.log('minimist לא נמצא ב-dependencies של package.json');
}

// בדיקה נוספת: האם minimist מופיע ב-devDependencies
if (packageJson.devDependencies && packageJson.devDependencies.minimist) {
    const currentVersion = packageJson.devDependencies.minimist;
    const minSafeVersion = '1.2.6';
    const latestSafeVersion = '1.2.8';
    
    const isVulnerable = currentVersion.startsWith('^0.') || 
                         currentVersion.startsWith('~0.') ||
                         currentVersion === '*' ||
                         (currentVersion.startsWith('^') && 
                          currentVersion.slice(1).localeCompare(minSafeVersion, undefined, { numeric: true }) < 0);
    
    if (isVulnerable) {
        console.log(`גרסת minimist ב-devDependencies פגיעה נמצאה: ${currentVersion}`);
        console.log(`מעדכן לגרסה בטוחה: ${latestSafeVersion}`);
        
        packageJson.devDependencies.minimist = `^${latestSafeVersion}`;
        fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
        
        console.log('package.json עודכן בהצלחה. יש להריץ npm install כדי להתקין את העדכון.');
    } else {
        console.log(`גרסת minimist ב-devDependencies כבר בטוחה: ${currentVersion}`);
    }
}