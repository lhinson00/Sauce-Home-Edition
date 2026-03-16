require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// File upload — store in memory, max 50MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
    cb(null, allowed.includes(file.mimetype));
  }
});

// ─────────────────────────────────────────────
// PDF → JPEG conversion via pdftoppm
// Returns array of base64 JPEG strings, one per page (up to maxPages)
// ─────────────────────────────────────────────
async function pdfToImages(pdfBuffer, maxPages = 6, dpi = 150) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauce-pdf-'));
  const tmpPdf = path.join(tmpDir, 'input.pdf');
  const outPrefix = path.join(tmpDir, 'page');

  try {
    fs.writeFileSync(tmpPdf, pdfBuffer);

    // pdftoppm: convert up to maxPages pages to JPEG at given DPI
    await execFileAsync('pdftoppm', [
      '-jpeg',
      '-r', String(dpi),
      '-l', String(maxPages),
      tmpPdf,
      outPrefix
    ]);

    // Collect generated page files, sorted
    const files = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('page') && f.endsWith('.jpg'))
      .sort()
      .slice(0, maxPages);

    if (files.length === 0) throw new Error('pdftoppm produced no output images');

    return files.map(f => {
      const buf = fs.readFileSync(path.join(tmpDir, f));
      return buf.toString('base64');
    });
  } finally {
    // Clean up temp files
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ─────────────────────────────────────────────
// ASSEMBLY RULES ENGINE — mirrors estimator.html logic exactly
// ─────────────────────────────────────────────

function runRulesEngine(extracted) {
  const results = { categories: [], flags: [], summary: {} };

  const {
    living_sf = 0,
    porch_sf = 0,
    building_width_ft: W = 0,
    building_depth_ft: L = 0,
    plate_height_ft: pH = 9,
    structural_roof_pitch: pitch = '6:12',
    ceiling_pitch = null,
    porch_pitch = '2:12',
    ext_wall_linear_ft = 0,
    int_wall_linear_ft = 0,
    plumbing_wall_linear_ft = 0,
    doors = [],
    windows = [],
    trusses = [],
    sheathing_type = 'OSB',
    roofing_type = 'Tuff-Rib 29ga',
    eave_overhang_in = 16,
    post_size = '8x8',
    porch_timber_spec = 'STD'
  } = extracted;

  if (ceiling_pitch && ceiling_pitch !== pitch) {
    results.flags.push({
      level: 'warning',
      message: `Floor plan shows ${ceiling_pitch} ceiling pitch (interior vault). Structural pitch is ${pitch}. All quantities calculated at ${pitch}. Confirm with engineer.`
    });
  }

  // ── PITCH MULTIPLIERS ──
  const PM = {'2:12':1.014,'3:12':1.031,'4:12':1.054,'5:12':1.083,'6:12':1.118,'7:12':1.158,'8:12':1.202,'10:12':1.302,'12:12':1.414};
  const pitchMult = PM[pitch] || 1.118;
  const porchMult = PM[porch_pitch] || 1.014;
  const overhangFt = eave_overhang_in / 12;

  // ── HELPERS ──
  function plates16(lf) { return Math.ceil(lf / 16); }
  function bestLen(span) { return [8,10,12,14,16,18,20].find(l => l >= span + 0.5) || 20; }
  function fmtHt(h) { const ft=Math.floor(h),inches=Math.round((h-ft)*12); return inches===0?`${ft}\'-0"`:`${ft}\'-${inches}"`; }
  function panelLength(runFt) {
    const exactInches = runFt * 12;
    const roundedInches = Math.ceil(exactInches);
    const finalInches = roundedInches + 3;
    const ft = Math.floor(finalInches / 12);
    const inches = finalInches % 12;
    return { ft, inches, totalInches: finalInches, display: inches===0?`${ft}\'-0"`:`${ft}\'-${inches}"`, decimal: finalInches/12 };
  }

  // ── DERIVED DIMENSIONS ──
  const perim = (W + L) * 2;
  const extLF = ext_wall_linear_ft || perim;
  const intLF = int_wall_linear_ft || Math.round(living_sf * 0.18);
  const plumbLF = plumbing_wall_linear_ft || 0;
  const livSF = living_sf || W * L;
  const porchWidth = W;
  const porchDepth = porch_sf > 0 ? Math.round(porch_sf / W) : 0;

  // ── ROOF AREAS ──
  const mainFlat = (W + overhangFt*2) * (L + overhangFt*2);
  const mainSloped = Math.round(mainFlat * pitchMult);
  const porchFlat = porch_sf > 0 ? porch_sf + (W * overhangFt) : 0;
  const porchSloped = Math.round(porchFlat * porchMult);
  const totalRoof = mainSloped + porchSloped;

  // ── DOOR / WINDOW COUNTS ──
  const dExt = doors.filter(d => d.is_exterior).reduce((a,d) => a + (d.count||1), 0);
  const dInt = doors.filter(d => !d.is_exterior).reduce((a,d) => a + (d.count||1), 0);
  const totalDoors = dExt + dInt;
  const totalWindows = windows.reduce((a,w) => a + (w.count||1), 0);
  const wStd = totalWindows;

  // ── EXT WALL FRAMING ──
  const extStuds = Math.ceil(extLF * 1.12);
  const extTopSticks = Math.ceil(plates16(extLF * 2) * 1.05);
  const extBotSticks = Math.ceil(plates16(extLF) * 1.05);
  const wallOSBSheets = Math.ceil(extLF * pH / 32 * 1.1);
  const houseWrapSF = Math.ceil(extLF * pH * 1.15);
  const extDoorHdrLen = dExt * 3.5;
  const extDoorHdrStk = bestLen(3.5);
  const extDoorHdrPcs = Math.ceil(extDoorHdrLen * 2 / extDoorHdrStk * 1.1);
  const winHdrLen = wStd * 3.5;
  const winHdrPcs = Math.ceil(winHdrLen * 2 / 10 * 1.1);

  results.categories.push({ name: 'EXTERIOR WALL FRAMING — 2×6 @ 16" OC', items: [
    { item:'Studs — 2×6 precut 104-5/8"', description:`${extLF} LF exterior wall @ 16" OC`, qty:extStuds, unit:'EA', lf:null, confidence:'high' },
    { item:"Top plate — 2×6 × 16'", description:`Double top plate · ${extTopSticks*16} LF · always 16' sticks`, qty:extTopSticks, unit:"PCS @ 16'", lf:extTopSticks*16, confidence:'high' },
    { item:"Bottom plate — 2×6 PT × 16'", description:`Single PT sill · ${extBotSticks*16} LF · always 16' sticks`, qty:extBotSticks, unit:"PCS @ 16'", lf:extBotSticks*16, confidence:'high' },
    { item:'Headers — (2) 2×12 ext. doors', description:`${dExt} ext. door(s) · doubled · ${extDoorHdrStk}' stock`, qty:extDoorHdrPcs, unit:`PCS @ ${extDoorHdrStk}'`, lf:Math.ceil(extDoorHdrLen*2), confidence:'high' },
    { item:'Headers — (2) 2×10 windows', description:`${totalWindows} window(s) · doubled · 10' stock`, qty:winHdrPcs, unit:"PCS @ 10'", lf:Math.ceil(winHdrLen*2), confidence:'high' },
    { item:`Wall sheathing — ${sheathing_type} 7/16" 4×8`, description:`${extLF} LF × ${pH}' plate height + 10% waste`, qty:wallOSBSheets, unit:'SHEETS', lf:null, confidence:'high' },
    ...(sheathing_type==='ZIP'
      ? [{ item:'ZIP tape', description:'1 roll per 100 LF seams', qty:Math.ceil(extLF/100), unit:'ROLLS', lf:null, confidence:'high' }]
      : [{ item:'House wrap', description:'Per wall SF + 15% overlap', qty:houseWrapSF.toLocaleString(), unit:'SF', lf:null, confidence:'high' }]),
  ]});

  // ── ROOF FRAMING ──
  const totalTrusses = Math.ceil(L / 2) + 1;
  const ridgeLF = Math.ceil(W * 1.1);
  const fasciaLF = Math.ceil(perim * 1.1);

  // Panel lengths needed for purlin rows
  const halfSpan = W / 2;
  const panelRunFt = (halfSpan + overhangFt) * pitchMult;
  const panel = panelLength(panelRunFt);

  const purlinRowsPerSlope = Math.ceil(panel.decimal / 2);
  const purlinRowsMain = purlinRowsPerSlope * 2;
  const purlin12Main = purlinRowsMain * 2;
  const purlin16Main = purlinRowsMain * Math.ceil(Math.max(0, L - 24) / 16);

  const porchPanelRunFt = porchDepth > 0 ? (porchDepth + overhangFt) * porchMult : 0;
  const porchPanel = porchDepth > 0 ? panelLength(porchPanelRunFt) : null;
  const purlinRowsPorch = porchDepth > 0 ? Math.ceil(porchPanel.decimal / 2) : 0;
  const purlin12Porch = porchDepth > 0 ? purlinRowsPorch * 2 : 0;
  const purlin16Porch = porchDepth > 0 ? purlinRowsPorch * Math.ceil(Math.max(0, porchWidth - 24) / 16) : 0;

  const roofFramingItems = [
    { item:'Trusses', description:`24" OC · ${L}' building length — confirm type with engineer`, qty:totalTrusses, unit:'EA', lf:null, confidence:'high' },
    { item:'Ridge nailer — 2×12 #2 SP', description:`Building width ${W}' + 10%`, qty:Math.ceil(W*1.1/16)+' sticks', unit:"PCS @ 16'", lf:ridgeLF, confidence:'high' },
    { item:"Purlins — 2×4 × 12' #2 SP", description:`Gable-end rows · 2 per row · ${purlinRowsMain} rows (${purlinRowsPerSlope}/slope)`, qty:purlin12Main, unit:"PCS @ 12'", lf:purlin12Main*12, confidence:'high' },
    { item:"Purlins — 2×4 × 16' #2 SP", description:`Fill rows · ${purlinRowsMain} rows`, qty:purlin16Main, unit:"PCS @ 16'", lf:purlin16Main*16, confidence:'high' },
    { item:'Fascia — 2×6 #2 SP', description:'Eave perimeter + 10%', qty:Math.ceil(fasciaLF/16), unit:"PCS @ 16'", lf:fasciaLF, confidence:'high' },
  ];
  results.categories.push({ name: `ROOF FRAMING — ${pitch} PITCH`, items: roofFramingItems });

  // ── INTERIOR WALL FRAMING ──
  const intStuds = Math.ceil(intLF * 1.12);
  const plumbStuds = Math.ceil(plumbLF * 1.12);
  const int2x4TopStks = Math.ceil(plates16(intLF * 2) * 1.05);
  const int2x4BotStks = Math.ceil(plates16(intLF) * 1.05);
  const int2x6TopStks = Math.ceil(plates16(plumbLF * 2) * 1.05);
  const int2x6BotStks = Math.ceil(plates16(plumbLF) * 1.05);
  const intDoorHdrPcs = Math.ceil(dInt * 2 / Math.floor(8 / 2.84) * 1.05);

  results.categories.push({ name: 'INTERIOR WALL FRAMING', items: [
    { item:'Studs — 2×4 precut 92-5/8"', description:`${intLF} LF interior wall @ 16" OC`, qty:intStuds, unit:'EA', lf:null, confidence:'medium' },
    { item:"Top plate — 2×4 × 16'", description:`Double top plate · ${int2x4TopStks*16} LF · always 16' sticks`, qty:int2x4TopStks, unit:"PCS @ 16'", lf:int2x4TopStks*16, confidence:'high' },
    { item:"Bottom plate — 2×4 × 16'", description:`Single bottom plate · ${int2x4BotStks*16} LF · always 16' sticks`, qty:int2x4BotStks, unit:"PCS @ 16'", lf:int2x4BotStks*16, confidence:'high' },
    { item:"Headers — (2) 2×6 int. doors", description:`${dInt} interior door(s) · cut from 8' stock`, qty:intDoorHdrPcs, unit:"PCS @ 8'", lf:Math.ceil(dInt*2.84*2), confidence:'high' },
    { item:'Ladder blocking — 2×4', description:'T-intersections throughout', qty:Math.ceil(intLF*0.15), unit:'LF', lf:Math.ceil(intLF*0.15), confidence:'medium' },
    ...(plumbLF > 0 ? [
      { item:'Studs — 2×6 plumbing walls', description:`${plumbLF} LF wet walls @ 16" OC`, qty:plumbStuds, unit:'EA', lf:null, confidence:'medium' },
      { item:"Top plate — 2×6 plumbing × 16'", description:`Double top plate · ${int2x6TopStks*16} LF · 16' sticks`, qty:int2x6TopStks, unit:"PCS @ 16'", lf:int2x6TopStks*16, confidence:'medium' },
      { item:"Bottom plate — 2×6 plumbing × 16'", description:`Single bottom plate · ${int2x6BotStks*16} LF · 16' sticks`, qty:int2x6BotStks, unit:"PCS @ 16'", lf:int2x6BotStks*16, confidence:'medium' },
    ] : []),
  ]});

  // ── PORCH FRAMING ──
  if (porchDepth > 0) {
    const isCypress = porch_timber_spec === 'CYP';
    const rafterSize = isCypress ? '4×6' : '2×6';
    const rafterSpacingFt = isCypress ? 4 : 2;
    const postSizeLabel = (post_size || '8x8').replace('x','×') + ' Cypress';
    const postSpacingFt = 10;
    const postCount = Math.ceil(porchWidth / postSpacingFt) + 1;
    const postLF = postCount * pH;
    const pitchAngle = Math.atan(parseInt(porch_pitch) / 12);
    const rafterCount = Math.ceil(porchWidth / rafterSpacingFt) + 1;
    const rafterLengthFt = Math.ceil(porchDepth / Math.cos(pitchAngle) + overhangFt + 0.5);
    const rafterStockLen = [8,10,12,14,16].find(l => l >= rafterLengthFt) || 16;
    const headerBeamSize = postSizeLabel.split(' ')[0];
    const headerBeamPcs = Math.ceil(porchWidth / postSpacingFt) + 1;
    const headerBeamLF = Math.ceil(porchWidth * 1.05);
    const porchRidgeLF = Math.ceil(porchWidth * 1.1);
    const porchRidgePcs = Math.ceil(porchRidgeLF / 16);
    const flyRafterLen = [8,10,12].find(l => l >= rafterLengthFt) || 12;
    const porchDeckSlopedDepth = porchDepth / Math.cos(pitchAngle);
    const porchDeckBoards = Math.ceil((porchWidth / (5.5/12)) * 1.1);
    const porchDeckLF = Math.ceil(porchDeckSlopedDepth * porchWidth / (5.5/12) * 1.1);
    const porchDeckBoardLen = [8,10,12,14,16].find(l => l >= Math.ceil(porchDeckSlopedDepth + 0.5)) || 16;

    results.categories.push({ name: `PORCH FRAMING — ${isCypress?'CYPRESS TIMBER':'STD TIMBER'} · ${postSizeLabel} POSTS`, items: [
      { item:`Posts — ${postSizeLabel}`, description:`${postCount} posts @ ${postSpacingFt}' OC · ${pH}' height`, qty:postCount, unit:'EA', lf:postLF, confidence:'high' },
      { item:`Rafters — ${rafterSize} ${isCypress?'Cypress':'#2 SYP'}`, description:`${rafterCount} rafters @ ${rafterSpacingFt*12}" OC · ${rafterLengthFt}' length · order ${rafterStockLen}' stock`, qty:rafterCount, unit:`EA @ ${rafterStockLen}'`, lf:rafterCount*rafterStockLen, confidence:'high' },
      { item:`Header beam — ${headerBeamSize} ${isCypress?'Cypress':'SYP'}`, description:`${headerBeamPcs} pcs · one per bay · ${postSpacingFt}' spacing · order ${postSpacingFt}' stock`, qty:headerBeamPcs, unit:`EA @ ${postSpacingFt}'`, lf:headerBeamLF, confidence:'high' },
      { item:'Ridge beam — 2×12 #2 SP', description:`Porch ridge · ${porchWidth}' + 10% waste`, qty:porchRidgePcs, unit:"PCS @ 16'", lf:porchRidgeLF, confidence:'high' },
      { item:'Fly rafters — 2×6 #2 SP', description:`Gable ends · ${flyRafterLen}' stock`, qty:4, unit:`EA @ ${flyRafterLen}'`, lf:4*flyRafterLen, confidence:'high' },
      { item:'Porch decking — 2×6 T&G #2 SP', description:`${porchDeckBoards} boards × ${porchDeckBoardLen}' stock · sloped depth ${porchDeckSlopedDepth.toFixed(2)}' · 5.5" true width`, qty:porchDeckBoards, unit:`EA @ ${porchDeckBoardLen}'`, lf:porchDeckLF, confidence:'high' },
      ...(purlin12Porch > 0 ? [{ item:"Purlins — 2×4 × 12' #2 SP · porch", description:`Gable-end rows · ${purlinRowsPorch} rows`, qty:purlin12Porch, unit:"PCS @ 12'", lf:purlin12Porch*12, confidence:'high' }] : []),
      ...(purlin16Porch > 0 ? [{ item:"Purlins — 2×4 × 16' #2 SP · porch", description:`Fill rows · ${purlinRowsPorch} rows`, qty:purlin16Porch, unit:"PCS @ 16'", lf:purlin16Porch*16, confidence:'high' }] : []),
    ]});
  }

  // ── ROOF METAL ──
  const roofOSBSheets = Math.ceil(totalRoof / 32 * 1.1);
  const panelsPerSlope = Math.ceil((L + overhangFt*2) / 3);
  const totalRoofPanels = panelsPerSlope * 2;
  const panelLengthDisplay = panel.display;
  const porchPanelsPerSlope = porchDepth > 0 ? Math.ceil((L + overhangFt*2) / 3) : 0;
  const ridgeCapRunLF = Math.ceil(L + overhangFt*2);
  const ridgeCapPcs = Math.ceil(ridgeCapRunLF / 10 * 1.1);
  const rakeTrimLF = Math.ceil(panel.decimal * 2 * 2 * 1.1);
  const rakeTrimPcs = Math.ceil(rakeTrimLF / 10);
  const eaveTrimPcs = Math.ceil((L + overhangFt*2) * 2 / 10 * 1.05);

  const roofMetalItems = [
    { item:`Roof sheathing — ${sheathing_type} 7/16" 4×8`, description:`${totalRoof.toLocaleString()} SF sloped area + 10%`, qty:roofOSBSheets, unit:'SHEETS', lf:null, confidence:'high' },
    ...(sheathing_type==='ZIP'
      ? [{ item:'ZIP tape — roof', description:'Seam sealing', qty:Math.ceil(totalRoof/100), unit:'ROLLS', lf:null, confidence:'high' }]
      : [{ item:'Underlayment — synthetic', description:'Full sloped area', qty:totalRoof.toLocaleString(), unit:'SF', lf:null, confidence:'high' }]),
    { item:`Main roof panels — ${panelLengthDisplay} each`, description:`(${W/2}' half-span + ${overhangFt.toFixed(2)}' OH) × ${pitch} = ${panel.totalInches}" = ${panelLengthDisplay} · ${panelsPerSlope}/slope`, qty:totalRoofPanels, unit:`PCS @ ${panelLengthDisplay}`, lf:Math.round(totalRoofPanels*panel.decimal), confidence:'high' },
    ...(porchDepth > 0 && porchPanel ? [{ item:`Porch panels — ${porchPanel.display} each`, description:`(${porchDepth}' depth + ${overhangFt.toFixed(2)}' OH) × ${porch_pitch} · ${porchPanelsPerSlope} panels`, qty:porchPanelsPerSlope, unit:`PCS @ ${porchPanel.display}`, lf:Math.round(porchPanelsPerSlope*porchPanel.decimal), confidence:'high' }] : []),
    { item:"Ridge cap — 10' sticks", description:`${ridgeCapRunLF}' run · 10% overlap`, qty:ridgeCapPcs, unit:"PCS @ 10'", lf:ridgeCapPcs*10, confidence:'high' },
    { item:'Rake trim — both gable ends', description:`${panelLengthDisplay} × 2 slopes × 2 ends + 10%`, qty:rakeTrimPcs, unit:"PCS @ 10'", lf:rakeTrimPcs*10, confidence:'high' },
    { item:'Eave trim / drip edge', description:`(${L}' + OH each end) × 2 slopes`, qty:eaveTrimPcs, unit:"PCS @ 10'", lf:eaveTrimPcs*10, confidence:'high' },
  ];
  results.categories.push({ name: `ROOF METAL — ${roofing_type} · Tuff-Rib 3' Coverage`, items: roofMetalItems });

  // ── WALL METAL ──
  const gableFirstOffset = {'4:12':2.0,'6:12':2.5,'8:12':3.0,'10:12':4.0}[pitch] || 2.5;
  const pitchNum = parseInt(pitch.split(':')[0]);
  const gableStep = (pitchNum / 12) * 3;
  const eaveWallLongCount = Math.ceil(L / 3);
  const eaveWallLongPanelH = pH;
  const gablePanelsPerHalf = Math.ceil((W / 2) / 3);
  const gableSchedule = [];
  for (let i = 0; i < gablePanelsPerHalf; i++) {
    const heightFt = pH + gableFirstOffset + (gableStep * i);
    const totalInches = Math.ceil(heightFt * 12);
    const ft = Math.floor(totalInches / 12);
    const inches = totalInches % 12;
    const display = inches===0?`${ft}\'-0"`:`${ft}\'-${inches}"`;
    gableSchedule.push({ heightFt, totalInches, display, qty: 4 });
  }
  const cornerTrimLF = Math.ceil(4 * pH * 1.1);
  const cornerTrimPcs = Math.ceil(cornerTrimLF / 10);
  const soffitPanelIn = eave_overhang_in + 1;
  const soffitPanelFt = Math.floor(soffitPanelIn / 12);
  const soffitPanelRem = soffitPanelIn % 12;
  const soffitPanelDisplay = soffitPanelRem===0?`${soffitPanelFt}\'-0"`:`${soffitPanelFt}\'-${soffitPanelRem}"`;
  const soffitPanelDecimal = soffitPanelIn / 12;
  const eaveSoffitCount = Math.ceil((L + overhangFt*2) / 3) * 2;
  const eaveSoffitLF = Math.round(eaveSoffitCount * soffitPanelDecimal);
  const gableSoffitPerHalf = Math.ceil(panel.decimal / 3);
  const gableSoffitCount = gableSoffitPerHalf * 4;
  const gableSoffitLF = Math.round(gableSoffitCount * soffitPanelDecimal);
  const porchSoffitCount = (porchDepth > 0 && porchPanel) ? Math.ceil(porchPanel.decimal / 3) * porchPanelsPerSlope : 0;
  const porchSoffitLF = Math.round(porchSoffitCount * soffitPanelDecimal);

  const wallMetalItems = [
    { item:`Eave wall panels — ${fmtHt(eaveWallLongPanelH)}`, description:`Front & back walls · ${L}' ÷ 3 = ${eaveWallLongCount} panels × 2 sides`, qty:eaveWallLongCount*2, unit:`PCS @ ${fmtHt(eaveWallLongPanelH)}`, lf:Math.round(eaveWallLongCount*2*eaveWallLongPanelH), confidence:'high' },
    ...gableSchedule.map((p,i) => ({
      item:`Gable panel ${i+1} of ${gablePanelsPerHalf} — ${p.display}`,
      description:`${i===0?`Eave ${pH}' + ${gableFirstOffset}' offset`:`Panel ${i} + ${gableStep.toFixed(2)}' step`} · 4 pcs (2 per half × 2 ends)`,
      qty:p.qty, unit:`PCS @ ${p.display}`, lf:Math.round(p.qty*(p.totalInches/12)), confidence:'high'
    })),
    { item:'Corner trim', description:`4 corners × ${pH}' eave height + 10%`, qty:cornerTrimPcs, unit:"PCS @ 10'", lf:cornerTrimPcs*10, confidence:'high' },
    { item:`Soffit panels — ${soffitPanelDisplay} · eave walls`, description:`(${L}' + OH each end) ÷ 3 × 2 eave sides`, qty:eaveSoffitCount, unit:`PCS @ ${soffitPanelDisplay}`, lf:eaveSoffitLF, confidence:'high' },
    { item:`Soffit panels — ${soffitPanelDisplay} · gable ends`, description:`Roof panel ${panelLengthDisplay} ÷ 3 = ${gableSoffitPerHalf}/half × 4`, qty:gableSoffitCount, unit:`PCS @ ${soffitPanelDisplay}`, lf:gableSoffitLF, confidence:'high' },
    ...(porchDepth > 0 && porchPanel ? [{ item:`Soffit panels — ${soffitPanelDisplay} · porch`, description:`Porch panel ÷ 3 × ${porchPanelsPerSlope} panels`, qty:porchSoffitCount, unit:`PCS @ ${soffitPanelDisplay}`, lf:porchSoffitLF, confidence:'high' }] : []),
  ];
  results.categories.push({ name: "WALL METAL — Tuff-Rib 3' Coverage", items: wallMetalItems });

  // ── SUMMARY ──
  results.summary = {
    living_sf: livSF,
    porch_sf,
    total_slab_sf: livSF + porch_sf,
    main_sloped_sf: mainSloped,
    porch_sloped_sf: porchSloped,
    total_sloped_sf: totalRoof,
    building_dimensions: `${W}' × ${L}'`,
    plate_height: `${pH}'-0"`,
    structural_roof_pitch: pitch,
    porch_pitch,
    total_doors: totalDoors,
    total_windows: totalWindows,
    total_glazing_sf: windows.reduce((a,w) => a+(w.area_sf||0), 0),
    sheathing_type,
    foundation_type: 'monolithic_slab'
  };

  return results;
}
// ─────────────────────────────────────────────
// EXTRACTION PROMPT
// ─────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are an expert at reading architectural and structural drawings for residential construction. Analyze this floor plan and return ONLY a valid JSON object with no other text, markdown, or explanation.

Extract every value you can find. Use null for fields you cannot read. Be precise with numbers.

Return this exact JSON structure:
{
  "project_name": "string or null",
  "sheet_info": "string or null",
  "living_sf": number,
  "porch_sf": number,
  "building_width_ft": number,
  "building_depth_ft": number,
  "plate_height_ft": number,
  "structural_roof_pitch": "X:12 string",
  "ceiling_pitch": "X:12 string or null if same as structural",
  "porch_pitch": "X:12 string or null",
  "ext_wall_linear_ft": number,
  "int_wall_linear_ft": number,
  "plumbing_wall_linear_ft": number,
  "exterior_corners": number,
  "int_t_intersections": number,
  "doors": [
    {
      "mark": "D01",
      "count": 1,
      "width_ft": 3.0,
      "height_ft": 6.67,
      "rough_opening_width_ft": 3.0,
      "rough_opening_height_ft": 6.67,
      "description": "Ext door",
      "header": "(2) 2x12",
      "is_exterior": true
    }
  ],
  "windows": [
    {
      "mark": "W01",
      "count": 1,
      "width_ft": 3.0,
      "height_ft": 5.5,
      "rough_opening_width_ft": 3.0,
      "rough_opening_height_ft": 5.5,
      "description": "Single hung",
      "header": "(2) 2x10",
      "area_sf": 16.5
    }
  ],
  "trusses": [
    {
      "mark": "T1",
      "type": "Flat bottom truss",
      "count": 12,
      "description": "24 OC"
    }
  ],
  "rough_timber": [
    {
      "mark": "R1",
      "size": "4x6",
      "count": 10,
      "description": "Porch rafters"
    }
  ],
  "sheathing_type": "OSB or ZIP",
  "roofing_type": "Tuff-Rib 29ga or other",
  "eave_overhang_in": 16,
  "roof_area_main_sf": number,
  "roof_area_porch_sf": number,
  "foundation_type": "monolithic_slab or stem_wall or pier_beam",
  "slab_thickness_in": 4,
  "notes": ["any important notes or flags as strings"]
}

Important rules:
- structural_roof_pitch is from the roof framing plan or elevation — NOT the ceiling vault note on the floor plan
- If ceiling pitch differs from structural pitch, set ceiling_pitch to the floor plan vault pitch
- For ext_wall_linear_ft: sum all exterior wall dimension strings if no net wall area is given
- For plumbing walls: any wall adjacent to bathroom fixtures, laundry, or kitchen wet wall
- If a truss or door schedule is shown, read every line exactly
- Expand door/window marks by count — if D03 has count 8, create 8 separate door entries or note count in the object`;

// ─────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────

// Analyze drawing
app.post('/api/analyze', upload.single('drawing'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

    const fileBuffer = req.file.buffer;
    const mimeType = req.file.mimetype;

    // Build content blocks — PDFs get converted to images first
    let contentBlocks = [];

    if (mimeType === 'application/pdf') {
      console.log(`PDF upload: ${req.file.originalname} — ${Math.round(fileBuffer.length/1024)}KB`);
      let pageImages;
      try {
        pageImages = await pdfToImages(fileBuffer, 6, 150);
        console.log(`Converted PDF to ${pageImages.length} page images`);
      } catch (convErr) {
        console.error('PDF conversion error:', convErr.message);
        return res.status(500).json({
          error: `Could not convert PDF to images: ${convErr.message}. Try uploading as JPG/PNG instead.`
        });
      }
      // Send each page as a separate image block
      contentBlocks = pageImages.map((b64, i) => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: b64 }
      }));
    } else {
      // Direct image upload
      const validType = ['image/jpeg','image/png','image/gif','image/webp'].includes(mimeType)
        ? mimeType : 'image/jpeg';
      const base64Data = fileBuffer.toString('base64');
      contentBlocks = [{ type: 'image', source: { type: 'base64', media_type: validType, data: base64Data } }];
    }

    // Add extraction prompt after all image blocks
    contentBlocks.push({ type: 'text', text: EXTRACTION_PROMPT });

    const messages = [{ role: 'user', content: contentBlocks }];

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', err);
      return res.status(500).json({ error: `API error: ${err}` });
    }

    const data = await response.json();
    console.log('API response content types:', data.content?.map(b=>b.type));
    const rawText = data.content.map(b => b.text || '').join('');
    console.log('Raw text length:', rawText.length, 'Preview:', rawText.substring(0,200));
    if (!rawText || rawText.length < 10) {
      return res.status(500).json({ error: 'AI returned empty response. Try a higher resolution image.' });
    }

    // Parse JSON from response
    let extracted;
    try {
      const clean = rawText.replace(/```json|```/g, '').trim();
      extracted = JSON.parse(clean);
    } catch (e) {
      console.error('JSON parse error:', e.message, 'Raw:', rawText.substring(0,300));
      return res.status(500).json({ error: 'Could not parse drawing data — the AI response was not valid JSON. Try a clearer image.', raw: rawText.substring(0, 300) });
    }

    // Run rules engine
    const takeoff = runRulesEngine(extracted);

    res.json({
      success: true,
      extracted,
      takeoff,
      filename: req.file.originalname
    });

  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Demo endpoint — uses sample plan data
app.get('/api/demo', (req, res) => {
  const samplePlan = {
    project_name: 'Sample Home',
    sheet_info: '1st Floor Layout — 3 Bed / 2 Bath Ranch',
    living_sf: 1680,
    porch_sf: 448,
    building_width_ft: 56,
    building_depth_ft: 35,
    plate_height_ft: 9,
    structural_roof_pitch: '6:12',
    ceiling_pitch: '3:12',
    porch_pitch: '2:12',
    ext_wall_linear_ft: 182,
    int_wall_linear_ft: 320,
    plumbing_wall_linear_ft: 48,
    exterior_corners: 4,
    int_t_intersections: 18,
    doors: [
      { mark: 'D01', count: 1, rough_opening_width_ft: 3, rough_opening_height_ft: 6.67, description: 'Ext. door w/ sidelites', header: '(2) 2x12', is_exterior: true },
      { mark: 'D02', count: 1, rough_opening_width_ft: 3, rough_opening_height_ft: 6.67, description: 'Ext. door RH', header: '(2) 2x10', is_exterior: true },
      { mark: 'D03', count: 8, rough_opening_width_ft: 2.67, rough_opening_height_ft: 6.67, description: 'Int. walk door', header: '(2) 2x6', is_exterior: false },
      { mark: 'D04', count: 3, rough_opening_width_ft: 5, rough_opening_height_ft: 6.67, description: 'Int. swing door', header: '(2) 2x6', is_exterior: false },
      { mark: 'D05', count: 1, rough_opening_width_ft: 2, rough_opening_height_ft: 6.67, description: 'Int. door', header: '(2) 2x6', is_exterior: false }
    ],
    windows: [
      { mark: 'W01', count: 6, rough_opening_width_ft: 3, rough_opening_height_ft: 5.5, description: 'Single hung', header: '(2) 2x10', area_sf: 16.5 },
      { mark: 'W02', count: 2, rough_opening_width_ft: 6, rough_opening_height_ft: 5.5, description: '3x5 Twin SH', header: '(2) 2x12', area_sf: 33 },
      { mark: 'W03', count: 2, rough_opening_width_ft: 3, rough_opening_height_ft: 3, description: 'Small SH', header: '(2) 2x10', area_sf: 9 }
    ],
    trusses: [
      { mark: 'G1', type: 'Gable truss', count: 4, description: '2 per gable end' },
      { mark: 'T1', type: 'Flat bottom truss', count: 12, description: '24" OC' },
      { mark: 'T2', type: 'Scissor truss', count: 15, description: 'Vaulted sections 24" OC' }
    ],
    rough_timber: [
      { mark: 'R1', size: '4x6', count: 10, description: 'Porch rafters' },
      { mark: 'R2', size: '4x6', count: 3, description: 'Transition members' },
      { mark: 'R3', size: '6x6', count: 1, description: 'Porch post' },
      { mark: 'R4', size: '2x6', count: 2, description: 'Transition framing' },
      { mark: 'R5', size: '2x10', count: 2, description: 'Beam member' },
      { mark: 'R6', size: '2x12', count: 2, description: 'Beam member' }
    ],
    sheathing_type: 'OSB',
    roofing_type: 'Tuff-Rib 29ga',
    eave_overhang_in: 16,
    roof_area_main_sf: 1949,
    roof_area_porch_sf: 701,
    foundation_type: 'monolithic_slab',
    slab_thickness_in: 4,
    notes: ['Exterior wall net area from schedule: 1,612 SF', 'Stone wainscoting front wall only — 3ft height']
  };

  const takeoff = runRulesEngine(samplePlan);
  res.json({ success: true, extracted: samplePlan, takeoff, filename: 'Sample_Home_Demo.pdf' });
});

// Health check
app.get('/api/health', (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  res.json({
    status: 'ok',
    version: '1.0.0',
    hasApiKey: !!key,
    keyPrefix: key ? key.substring(0, 10) + '...' : 'NOT SET'
  });
});

// Serve specific HTML pages explicitly
app.get('/estimator.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'estimator.html')));
app.get('/designer.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'designer.html')));
app.get('/upload.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'upload.html')));

// Catch-all — serve index for everything else
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`HomeBuild AI running on port ${PORT}`));
