// Ajuste le projet Android généré par Capacitor : icône, numéro de version, scanner ML Kit.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const res = path.join(root, 'android/app/src/main/res');
const run = parseInt(process.env.BUILD_NUMBER || '1', 10);

// 1) Icônes
const iconsDir = path.join(root, 'resources/android');
for (const d of fs.readdirSync(iconsDir)) {
  for (const f of fs.readdirSync(path.join(iconsDir, d))) {
    fs.mkdirSync(path.join(res, d), { recursive: true });
    fs.copyFileSync(path.join(iconsDir, d, f), path.join(res, d, f));
  }
  // supprime l'icône « adaptative » par défaut de Capacitor
  const fg = path.join(res, d, 'ic_launcher_foreground.png');
  if (fs.existsSync(fg)) fs.rmSync(fg);
}
fs.rmSync(path.join(res, 'mipmap-anydpi-v26'), { recursive: true, force: true });

// 2) Version : chaque compilation a un numéro plus grand, pour pouvoir installer par-dessus
const gradleFile = path.join(root, 'android/app/build.gradle');
let g = fs.readFileSync(gradleFile, 'utf8');
g = g.replace(/versionCode\s+\d+/, 'versionCode ' + run).replace(/versionName\s+"[^"]*"/, `versionName "0.1.${run}"`);
fs.writeFileSync(gradleFile, g);

// 3) Demande à Google Play de télécharger le module de scan dès l'installation
const manifestFile = path.join(root, 'android/app/src/main/AndroidManifest.xml');
let m = fs.readFileSync(manifestFile, 'utf8');
if (!m.includes('com.google.mlkit.vision.DEPENDENCIES')) {
  m = m.replace('<application', '<application').replace(/(<application[^>]*>)/,
    '$1\n        <meta-data android:name="com.google.mlkit.vision.DEPENDENCIES" android:value="barcode_ui" />');
}
fs.writeFileSync(manifestFile, m);

console.log('Projet Android ajusté, version 0.1.' + run);
