// Simple script to generate SVG icons and convert to PNG
// Run with: node generate-icons.js

const fs = require('fs');

// SVG icon template
const svgIcon = `
<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#007cba;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#005a87;stop-opacity:1" />
    </linearGradient>
  </defs>
  
  <!-- Background circle -->
  <circle cx="64" cy="64" r="58" fill="url(#grad)" stroke="#003d5c" stroke-width="2"/>
  
  <!-- Browser window -->
  <rect x="20" y="35" width="88" height="58" rx="4" fill="white" stroke="#ddd" stroke-width="1"/>
  
  <!-- Browser tabs -->
  <rect x="24" y="35" width="20" height="8" rx="2" fill="#007cba"/>
  <rect x="46" y="35" width="20" height="8" rx="2" fill="#ccc"/>
  
  <!-- Browser content area -->
  <rect x="24" y="47" width="80" height="42" fill="#f8f9fa" stroke="#eee" stroke-width="1"/>
  
  <!-- Code/content lines -->
  <rect x="28" y="51" width="24" height="2" fill="#007cba"/>
  <rect x="28" y="55" width="36" height="2" fill="#666"/>
  <rect x="28" y="59" width="28" height="2" fill="#666"/>
  <rect x="28" y="63" width="40" height="2" fill="#666"/>
  <rect x="28" y="67" width="20" height="2" fill="#007cba"/>
  
  <!-- Connection indicator -->
  <circle cx="96" cy="42" r="4" fill="#4CAF50" stroke="white" stroke-width="1"/>
  
  <!-- MCP text -->
  <text x="64" y="110" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" font-weight="bold" fill="white">MCP</text>
</svg>
`.trim();

// Create SVG file
fs.writeFileSync('icon.svg', svgIcon);

console.log('Generated icon.svg');
console.log('To create PNG files, use an online converter or install sharp:');
console.log('npm install sharp');
console.log('Then use sharp to convert SVG to PNG at different sizes');

// If sharp is available, try to convert
try {
  const sharp = require('sharp');
  
  const sizes = [16, 48, 128];
  
  sizes.forEach(size => {
    sharp(Buffer.from(svgIcon))
      .resize(size, size)
      .png()
      .toFile(`icon-${size}.png`)
      .then(() => console.log(`Generated icon-${size}.png`))
      .catch(err => console.log(`Could not generate PNG: ${err.message}`));
  });
  
} catch (err) {
  console.log('Sharp not installed. Manual PNG conversion needed.');
  console.log('Install with: npm install sharp');
}