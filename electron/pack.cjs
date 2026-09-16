const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { packager } = require('@electron/packager');

const root = process.cwd();
const stageDir = path.join(root, '.electron-stage');
const outDir = path.join(root, 'release');

console.log('Building Vite frontend...');
execSync('npm run build', { stdio: 'inherit', env: { ...process.env, ELECTRON: 'true' } });

console.log('Preparing clean staging area...');
if (fs.existsSync(stageDir)) {
  fs.rmSync(stageDir, { recursive: true, force: true });
}
fs.mkdirSync(stageDir, { recursive: true });

// Copy only dist, electron, and minimal package.json
fs.cpSync(path.join(root, 'dist'), path.join(stageDir, 'dist'), { recursive: true });
fs.cpSync(path.join(root, 'electron'), path.join(stageDir, 'electron'), { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const stagePkg = {
  name: 'shapeforge',
  version: pkg.version,
  main: 'electron/main.cjs',
  description: pkg.description || 'ShapeForge 3D CAD',
  author: pkg.author || 'ShapeForge Team',
};
fs.writeFileSync(path.join(stageDir, 'package.json'), JSON.stringify(stagePkg, null, 2));

console.log('Packaging ShapeForge.exe...');
packager({
  dir: stageDir,
  name: 'ShapeForge',
  platform: 'win32',
  arch: 'x64',
  out: outDir,
  overwrite: true,
  asar: true,
  prune: true,
}).then((appPaths) => {
  // Clean up stage dir
  try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
  console.log('\n========================================');
  console.log('SUCCESS! Packaged to:');
  console.log(appPaths[0]);
  console.log('========================================\n');
}).catch((err) => {
  console.error('Packaging failed:', err);
  process.exit(1);
});
