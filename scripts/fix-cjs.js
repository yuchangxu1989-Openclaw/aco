import fs from 'node:fs';
import path from 'node:path';

// Fix CJS output: add .js extensions and package.json with type: commonjs
const cjsDir = path.resolve('dist/cjs');

function addCjsPackageJson() {
  fs.writeFileSync(
    path.join(cjsDir, 'package.json'),
    JSON.stringify({ type: 'commonjs' }, null, 2)
  );
}

if (fs.existsSync(cjsDir)) {
  addCjsPackageJson();
}
