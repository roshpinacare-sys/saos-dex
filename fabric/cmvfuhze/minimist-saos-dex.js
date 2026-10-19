const fs = require('fs');
const path = require('path');

// Function to search for minimist usage in files
function searchMinimistUsage(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        const results = [];
        
        // Check for require/import statements
        const requireRegex = /require\(['"]minimist['"]\)/g;
        const importRegex = /import.*minimist/g;
        
        lines.forEach((line, index) => {
            if (requireRegex.test(line) || importRegex.test(line)) {
                results.push({
                    line: index + 1,
                    content: line.trim(),
                    type: 'import'
                });
            }
            
            // Check for minimist function calls
            const minimistCallRegex = /minimist\(\s*([^)]+)\s*\)/g;
            let match;
            while ((match = minimistCallRegex.exec(line)) !== null) {
                results.push({
                    line: index + 1,
                    content: line.trim(),
                    type: 'function_call',
                    arguments: match[1]
                });
            }
        });
        
        return results;
    } catch (error) {
        console.error(`Error reading file ${filePath}:`, error.message);
        return [];
    }
}

// Function to analyze minimist usage for Prototype Pollution vulnerability
function analyzeVulnerability(usage) {
    if (usage.type === 'import') {
        return {
            vulnerability: 'Low',
            reason: 'Import statements themselves are not vulnerable, but how minimist is used with the parsed arguments may be.'
        };
    } else if (usage.type === 'function_call') {
        // Check for dangerous patterns
        const dangerousPatterns = [
            /\bprocess\.argv\b/g,
            /\bObject\.assign\(/g,
            /\b\{\s*__proto__\s*:/g,
            /\b\{\s*constructor\s*:/g,
            /\b\{\s*__proto__\s*:\s*null\s*}/g
        ];
        
        let isDangerous = false;
        let reason = 'Usage appears safe';
        
        for (const pattern of dangerousPatterns) {
            if (pattern.test(usage.content)) {
                isDangerous = true;
                reason = 'Potential Prototype Pollution vulnerability detected';
                break;
            }
        }
        
        return {
            vulnerability: isDangerous ? 'High' : 'Medium',
            reason: reason
        };
    }
    
    return {
        vulnerability: 'Unknown',
        reason: 'Could not determine vulnerability level'
    };
}

// Function to suggest alternatives
function suggestAlternatives(usage) {
    if (usage.type === 'import') {
        return [
            'Consider using yargs for more robust argument parsing',
            'For simple cases, consider using built-in process.argv with manual parsing',
            'Use commander.js for a more feature-rich CLI parsing library'
        ];
    } else if (usage.type === 'function_call') {
        return [
            'Replace minimist with yargs or commander.js',
            'If parsing process.argv, use a safer approach:',
            '  const args = process.argv.slice(2);',
            '  const options = {};',
            '  for (const arg of args) {',
            '    if (arg.startsWith("--")) {',
            '      const [key, value] = arg.slice(2).split("=");',
            '      options[key] = value || true;',
            '    } else if (arg.startsWith("-")) {',
            '      options[arg.slice(1)] = true;',
            '    }',
            '  }',
            'Avoid directly assigning parsed arguments to objects without validation'
        ];
    }
    
    return ['No specific alternatives available for this usage pattern'];
}

// Main function to scan the project
function scanProjectForMinimist(rootDir) {
    const results = {
        packageJsonFiles: [],
        sourceFiles: [],
        summary: {
            totalFiles: 0,
            vulnerableUsages: 0,
            safeUsages: 0,
            recommendations: []
        }
    };
    
    // Check package.json files
    const packageJsonPath = path.join(rootDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
        try {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            if (packageJson.dependencies && packageJson.dependencies.minimist) {
                results.packageJsonFiles.push({
                    file: packageJsonPath,
                    version: packageJson.dependencies.minimist,
                    recommendation: 'Update minimist to a newer version or replace with a safer alternative like yargs or commander.js'
                });
                results.summary.totalFiles++;
            }
            
            if (packageJson.devDependencies && packageJson.devDependencies.minimist) {
                results.packageJsonFiles.push({
                    file: packageJsonPath,
                    version: packageJson.devDependencies.minimist,
                    recommendation: 'Update minimist to a newer version or replace with a safer alternative like yargs or commander.js'
                });
                results.summary.totalFiles++;
            }
        } catch (error) {
            console.error(`Error reading package.json:`, error.message);
        }
    }
    
    // Scan source files
    scanDirectory(rootDir, results);
    
    // Analyze findings
    results.sourceFiles.forEach(file => {
        file.usages.forEach(usage => {
            const analysis = analyzeVulnerability(usage);
            usage.vulnerability = analysis.vulnerability;
            usage.vulnerabilityReason = analysis.reason;
            usage.alternatives = suggestAlternatives(usage);
            
            if (analysis.vulnerability === 'High' || analysis.vulnerability === 'Medium') {
                results.summary.vulnerableUsages++;
            } else {
                results.summary.safeUsages++;
            }
        });
    });
    
    // Generate summary recommendations
    if (results.summary.vulnerableUsages > 0) {
        results.summary.recommendations.push(
            `${results.summary.vulnerableUsages} usage(s) of minimist identified with potential Prototype Pollution vulnerabilities. Immediate action required.`
        );
    }
    
    if (results.packageJsonFiles.length > 0) {
        results.summary.recommendations.push(
            'Minimist is listed as a dependency in package.json. Consider replacing it with a more secure alternative.'
        );
    }
    
    if (results.summary.totalFiles === 0) {
        results.summary.recommendations.push(
            'No minimist usage found in the project. No action required.'
        );
    }
    
    return results;
}

// Helper function to scan directory
function scanDirectory(dir, results) {
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        
        if (stat.isDirectory()) {
            // Skip node_modules and other directories
            if (file !== 'node_modules' && file !== '.git' && file !== 'dist' && file !== 'build') {
                scanDirectory(filePath, results);
            }
        } else if (file.endsWith('.js') || file.endsWith('.ts') || file.endsWith('.jsx') || file.endsWith('.tsx')) {
            const usages = searchMinimistUsage(filePath);
            if (usages.length > 0) {
                results.sourceFiles.push({
                    file: filePath,
                    usages: usages
                });
                results.summary.totalFiles += usages.length;
            }
        }
    }
}

// Example usage
const projectDir = process.cwd(); // Use current directory or specify path
const scanResults = scanProjectForMinimist(projectDir);

console.log(JSON.stringify(scanResults, null, 2));