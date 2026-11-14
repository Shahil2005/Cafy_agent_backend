/**
 * Extract base64 images from Cafy Email HTML, host them as static files,
 * and write production-ready templates into ProductBackend/email/templates.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcDir = path.join(root, 'Cafy Emails');
const tplOut = path.join(root, 'ProductBackend', 'email', 'templates');
const imgDirs = [
    path.join(root, 'CompanySite', 'public', 'emails'),
    path.join(root, 'CompanySite', 'dist', 'emails'),
];
const assetBase = 'https://www.cafy.careers/emails';

const files = [
    'email-1-winback-premium.html',
    'email-2-free-to-premium.html',
    'email-3-complete-onboarding.html',
];

for (const dir of imgDirs) {
    fs.mkdirSync(dir, { recursive: true });
}
fs.mkdirSync(tplOut, { recursive: true });

const hashToName = new Map();

function extFor(mime) {
    if (mime === 'png') return 'png';
    if (mime === 'jpeg' || mime === 'jpg') return 'jpg';
    if (mime === 'gif') return 'gif';
    return 'bin';
}

function writeImage(mime, b64) {
    const buf = Buffer.from(b64, 'base64');
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
    const ext = extFor(mime);
    const name = `${hash}.${ext}`;
    if (!hashToName.has(hash)) {
        hashToName.set(hash, name);
        for (const dir of imgDirs) {
            fs.writeFileSync(path.join(dir, name), buf);
        }
    }
    return name;
}

function applyProductionFixes(filename, html) {
    let out = html
        .replaceAll('https://cafy.careers/pricing', 'https://app.cafy.careers/subscription')
        .replaceAll('https://cafy.careers/help', 'https://cafy.careers/contact')
        .replaceAll('https://cafy.careers/api/feedback', 'https://cafy.careers/feedback');

    if (filename === 'email-2-free-to-premium.html') {
        out = out.replace(
            '4 <span style="font-size:24px;font-weight:600;color:#94A3B8;letter-spacing:0;">/ 5</span>',
            '{{used_count}} <span style="font-size:24px;font-weight:600;color:#94A3B8;letter-spacing:0;">/ {{limit}}</span>'
        );
        out = out.replace('1 use remaining', '{{remaining_count}} use remaining');
        out = out.replace('width="80%"', 'width="{{usage_percent}}%"');
    }

    return out;
}

const dataUri = /src="data:image\/(png|jpeg|jpg|gif);base64,([^"]+)"/gi;

for (const file of files) {
    const raw = fs.readFileSync(path.join(srcDir, file), 'utf8');
    const withImages = raw.replace(dataUri, (_m, mime, b64) => {
        const name = writeImage(String(mime).toLowerCase(), b64);
        return `src="${assetBase}/${name}"`;
    });
    const finalHtml = applyProductionFixes(file, withImages);
    fs.writeFileSync(path.join(tplOut, file), finalHtml, 'utf8');
    console.log(`wrote ${file} (${(finalHtml.length / 1024).toFixed(1)} KB)`);
}

console.log(`extracted ${hashToName.size} unique images`);
