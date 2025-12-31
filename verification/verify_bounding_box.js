const fs = require('fs');
const path = require('path');

// Check index.html for bounding box logic
const indexContent = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

const checks = {
    hasStrokeRect: indexContent.includes('ctx.strokeRect'),
    hasLineDash: indexContent.includes('ctx.setLineDash([8, 8])'), // Check specifically for the box dash pattern
    calculatesBounds: indexContent.includes('Math.min(minX, p.x)') && indexContent.includes('Math.max(maxX, p.x)')
};

console.log('Bounding Box Verification:', checks);
