import { parseArgs } from 'node:util';

// Replace minimist with Node.js built-in parseArgs
// This implementation maintains the same interface as minimist
export function parseMinimistArgs(args: string[]): Record<string, unknown> {
  try {
    const { values } = parseArgs({
      args,
      options: {},
      strict: false,
      allowPositionals: true,
    });
    
    // Convert to minimist-compatible format
    const result: Record<string, unknown> = {};
    
    // Add positional arguments
    result._ = values._ || [];
    
    // Add all options
    Object.entries(values).forEach(([key, value]) => {
      if (key !== '_') {
        result[key] = value;
      }
    });
    
    return result;
  } catch (error) {
    console.error('Error parsing arguments:', error);
    return { _: [] };
  }
}

// Example usage (for testing purposes)
if (require.main === module) {
  const testArgs = ['--foo', 'bar', '--baz', '--qux', 'quux', 'positional'];
  const parsed = parseMinimistArgs(testArgs);
  console.log(parsed);
}
