const fs = require('fs');
const path = require('path');

// Check analyze.js content for required changes
const analyzeContent = fs.readFileSync(path.join(__dirname, '../src/controllers/analyze.js'), 'utf8');

let checks = {
    viewpointInPrompt: analyzeContent.includes('viewpoint'),
    locationRefinement: analyzeContent.includes('location'),
    minConfidenceHandling: analyzeContent.includes('minConfidence'),
    filteringLogic: analyzeContent.includes('damage.confidence >= minConfidence')
};

console.log('Static Analysis of analyze.js:', checks);

// Check index.html for required changes
const indexContent = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
checks.sliderExists = indexContent.includes('id="confidence-threshold"');
checks.apiCallUpdated = indexContent.includes('minConfidence:');
checks.drawOnCanvasUpdated = indexContent.includes('shadowBlur') && indexContent.includes('setLineDash');

console.log('Static Analysis of index.html:', checks);
