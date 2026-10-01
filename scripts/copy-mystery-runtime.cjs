const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const source = path.join(projectRoot, 'src', 'modules', 'mystery');
const destination = path.join(projectRoot, 'dist', 'modules', 'mystery');

function copyDirectory(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const sourcePath = path.join(from, entry.name);
        const targetPath = path.join(to, entry.name);
        if (entry.isDirectory()) copyDirectory(sourcePath, targetPath);
        else if (entry.name.endsWith('.js')) fs.copyFileSync(sourcePath, targetPath);
    }
}
copyDirectory(source, destination);
