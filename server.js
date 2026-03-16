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
app.use(express.json({ limit: '25mb' }));
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
// PDF → JPEG conversion via pdftoppm + auto-rotate
// ─────────────────────────────────────────────
async function pdfToImages(pdfBuffer, maxPages = 6, dpi = 200) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauce-pdf-'));
  const tmpPdf = path.join(tmpDir, 'input.pdf');
  const outPrefix = path.join(tmpDir, 'page');

  try {
    fs.writeFileSync(tmpPdf, pdfBuffer);

    await execFileAsync('pdftoppm', [
      '-jpeg', '-r', String(dpi), '-l', String(maxPages), tmpPdf, outPrefix
    ]);

    const files = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('page') && f.endsWith('.jpg'))
      .sort()
      .slice(0, maxPages);

    if (files.length === 0) throw new Error('pdftoppm produced no output images');

    const results = [];
    for (const f of files) {
      const imgPath = path.join(tmpDir, f);
      try {
        // Check dimensions — if portrait (height > width by 20%), rotate 90° to landscape
        const { stdout } = await execFileAsync('identify', ['-format', '%w %h', imgPath]);
        const [w, h] = stdout.trim().split(' ').map(Number);
        if (h > w * 1.2) {
          const rotPath = path.join(tmpDir, 'rot_' + f);
          await execFileAsync('convert', [imgPath, '-rotate', '90', rotPath]);
          results.push(fs.readFileSync(rotPath).toString('base64'));
        } else {
          results.push(fs.readFileSync(imgPath).toString('base64'));
        }
      } catch {
        results.push(fs.readFileSync(imgPath).toString('base64'));
      }
    }
    return results;
  } finally {
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
    porch_width_ft = 0,
    porch_depth_ft = 0,
    building_width_ft: W = 0,
    building_depth_ft: L = 0,
    plate_height_ft: pH = 9,
    structural_roof_pitch: pitch = '6:12',
    ceiling_pitch = null,
    porch_pitch = '2:12',
    eave_overhang_in = 16,
    ext_wall_linear_ft = 0,
    int_wall_linear_ft = 0,
    plumbing_wall_linear_ft = 0,
    blocking_lf = 0,
    int_t_intersections = 0,
    doors = [],
    windows = [],
    trusses = [],
    sheathing_type = 'OSB',
    roofing_type = 'Tuff-Rib 29ga',
    post_size = '8x8',
    post_spacing_ft = 10,
    porch_timber_spec = 'STD',
    wainscot_type = null,
    wainscot_height_ft = 0,
    wainscot_walls = null,
    has_gable_popup = false,
    gable_popup_width_ft = null,
    gable_popup_pitch = null,
    foundation_type = 'monolithic_slab',
    slab_thickness_in = 4
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
  const livSF = living_sf || W * L;
  const extLF = ext_wall_linear_ft || perim;
  // Sanity check: if extracted int_wall_linear_ft is >= ext_wall_linear_ft,
  // Claude almost certainly included exterior walls — fall back to formula
  const intLFraw = int_wall_linear_ft || 0;
  const intLF = (intLFraw > 0 && intLFraw < extLF * 0.9)
    ? intLFraw
    : Math.round(livSF * 0.14);
  if (intLFraw >= extLF * 0.9 && intLFraw > 0) {
    results.flags.push({ level: 'warning', message: `Extracted interior wall LF (${intLFraw}) appears to include exterior walls — recalculated from living SF. Verify interior wall count.` });
  }
  const plumbLF = plumbing_wall_linear_ft || 0;
  const blockingLF = blocking_lf || (int_t_intersections > 0 ? int_t_intersections * 3 : Math.ceil(intLF * 0.2));

  // Use extracted porch dimensions if available, otherwise infer from porch_sf
  const porchWidth = porch_width_ft || W;
  const porchDepth = porch_depth_ft || (porch_sf > 0 ? Math.round(porch_sf / (porch_width_ft || W)) : 0);
  const porchSF = porch_sf || (porchWidth * porchDepth);
  const postSpacingFt = post_spacing_ft || 10;

  // ── ROOF AREAS ──
  const mainFlat = (W + overhangFt*2) * (L + overhangFt*2);
  const mainSloped = Math.round(mainFlat * pitchMult);
  const porchFlat = porchSF > 0 ? porchSF + (porchWidth * overhangFt) : 0;
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
    { item:'Ladder blocking — 2×4', description:'T-intersections throughout', qty:blockingLF, unit:'LF', lf:blockingLF, confidence:'medium' },
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
    porch_sf: porchSF,
    total_slab_sf: livSF + porchSF,
    main_sloped_sf: mainSloped,
    porch_sloped_sf: porchSloped,
    total_sloped_sf: totalRoof,
    building_dimensions: `${W}' × ${L}'`,
    plate_height: `${pH}'-0"`,
    structural_roof_pitch: pitch,
    porch_pitch,
    ext_wall_lf: extLF,
    int_wall_lf: intLF,
    plumb_wall_lf: plumbLF,
    blocking_lf: blockingLF,
    total_doors: totalDoors,
    total_windows: totalWindows,
    total_glazing_sf: windows.reduce((a,w) => a+(w.area_sf||0), 0),
    sheathing_type,
    foundation_type,
    wainscot_type: wainscot_type || 'none',
    has_gable_popup
  };

  return results;
}
// ─────────────────────────────────────────────
// EXTRACTION PROMPT
// ─────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a licensed general contractor and expert construction estimator. You are reading a residential plan set to produce a complete material takeoff. You will receive one or more pages — floor plan, elevations, framing plans, roof plan, sections, schedules, and notes. Read EVERY page thoroughly before responding.

Return ONLY a valid JSON object. No markdown, no explanation, no text outside the JSON.

═══════════════════════════════════════════
STEP 1 — IDENTIFY EVERY PAGE YOU CAN SEE
═══════════════════════════════════════════
Before extracting, note which sheets are present: floor plan, foundation plan, roof framing plan, truss layout, front/rear/side elevations, wall sections, door schedule, window schedule, finish schedule, general notes. Read all of them.

═══════════════════════════════════════════
STEP 2 — SQUARE FOOTAGE (read directly, do not calculate unless no callout exists)
═══════════════════════════════════════════
- living_sf: Look in the title block, general notes, or room schedule for a labeled "LIVING AREA", "CONDITIONED SPACE", "HEATED AREA", or "TOTAL LIVING SF" callout. Use that number exactly. If not labeled, sum individual room SF callouts shown inside each room. Only use width × depth as absolute last resort. NEVER include porch, garage, or utility areas in this number.
- porch_sf: Look for "FRONT PORCH", "REAR PORCH", "COVERED PORCH", or "PORCH" with an SF label or dimensions. Calculate as porch_width × porch_depth from dimension strings. If multiple porches exist, sum them. Never include in living_sf.
- garage_sf: Look for "GARAGE" label with SF or dimensions. Calculate if needed. Set to 0 if no garage.
- total_conditioned_sf: living_sf only — never include porch or garage.

═══════════════════════════════════════════
STEP 3 — BUILDING DIMENSIONS (read from exterior dimension strings)
═══════════════════════════════════════════
- building_width_ft: The overall outside-to-outside horizontal dimension of the main building footprint. Read the largest continuous horizontal dimension string on the floor plan exterior. Do NOT include porch.
- building_depth_ft: The overall outside-to-outside vertical dimension. Read the largest continuous vertical dimension string. Do NOT include porch.
- plate_height_ft: Look on elevations for "WALL HEIGHT", "PLATE HT", or "TOP OF PLATE" dimension. Also check general notes or sections. Typically 8, 9, 10, or 12 feet.
- ridge_height_ft: Read from elevation — "RIDGE HEIGHT" dimension if shown.
- porch_width_ft: Read the dimension string along the porch face (parallel to house front). Usually equals building_width_ft but may be less.
- porch_depth_ft: Read the dimension string showing porch depth (perpendicular to house). Typically 8-12 feet.

═══════════════════════════════════════════
STEP 4 — WALL LINEAR FOOTAGE (trace every wall — do not estimate)
═══════════════════════════════════════════
- ext_wall_linear_ft: Trace the entire exterior perimeter of the main building on the floor plan. Sum every exterior dimension string. For a simple rectangle this equals (width + depth) × 2. For L-shape or complex footprint, sum all exterior wall segments. Include garage walls if attached.
- int_wall_linear_ft: Count ONLY true interior partition walls — walls that have living space on BOTH sides. DO NOT include exterior walls, even if they form the boundary of a room. An exterior wall is any wall on the outside perimeter of the building. Interior partitions are: walls between rooms, closet walls, hallway walls, bathroom partition walls, kitchen walls that separate rooms. For each partition wall, read its dimension string and add it. Do not double-count — each wall segment counts once. A 1,500 SF house typically has 150-220 LF of true interior partitions. A 2,000 SF house: 180-280 LF. A 2,500 SF house: 220-340 LF.
- plumbing_wall_linear_ft: Identify every wall adjacent to plumbing fixtures: all bathroom walls containing or backing toilet/tub/shower/sink, kitchen wet wall, laundry room walls, water heater closet. These must be framed as 2×6. Sum their lengths separately.
- ext_wall_net_sf: ext_wall_linear_ft × plate_height_ft × 0.85 (15% deduct for openings). Calculate this yourself from those two values.

═══════════════════════════════════════════
STEP 5 — INTERIOR WALL DETAILS
═══════════════════════════════════════════
- int_t_intersections: Count every place where an interior wall meets another wall at a T (not a corner). Count carefully on the floor plan. Typically 12-30 for a standard home.
- int_corner_count: Count every interior corner (L-intersection of two interior walls).
- blocking_lf: int_t_intersections × 3 LF per intersection. If blocking is explicitly called out in notes or sections, use that value instead.
- double_top_plate_lf: ext_wall_linear_ft × 2 (double top plate on all exterior walls) + int_wall_linear_ft × 2.

═══════════════════════════════════════════
STEP 6 — ROOF SYSTEM (read from roof framing plan and elevations)
═══════════════════════════════════════════
- structural_roof_pitch: Read from the roof framing plan or elevation — look for the pitch triangle symbol (rise over run). This is the STRUCTURAL pitch of the main roof. Never use a ceiling vault note for this field. Format as "X:12".
- ceiling_pitch: If the floor plan shows a "VAULT", "CATHEDRAL", or "X:12 PITCH VAULT" ceiling note in any room, record that pitch here. Set to null if no vault or same as structural.
- porch_pitch: Read porch roof pitch from elevations or porch framing plan. Typically 2:12, 3:12, or 4:12. Format as "X:12".
- eave_overhang_in: Read from elevation or roof framing plan — the horizontal overhang distance in inches. Look for dimension from face of wall to fascia. Typically 12, 16, or 24 inches.
- roof_type: "gable", "hip", "shed", or "combination". Read from roof plan or elevation.
- has_gable_popup: true if a gable dormer or pop-out is shown on the porch or main roof, false otherwise.
- gable_popup_width_ft: Width of gable pop-out if present. Read from framing plan or elevation.
- gable_popup_pitch: Pitch of gable pop-out if present. Typically 8:12 or steeper.

═══════════════════════════════════════════
STEP 7 — PORCH FRAMING (read from porch framing plan, elevations, and notes)
═══════════════════════════════════════════
- post_size: Read from porch framing notes or elevation callouts. Look for "6×6 ROUGH TIMBER", "8×8 CYPRESS", "10×10 POST", etc. Default "8x8" if not found.
- post_spacing_ft: Read post spacing from porch plan dimension strings or elevation. Typically 8, 10, or 12 feet.
- porch_timber_spec: "CYP" if cypress is specified anywhere in porch notes, "STD" otherwise.
- porch_rafter_size: Read rafter size from porch framing notes. Look for "2×6", "4×6", "2×8" with "RAFTER" or "TIMBER" label.
- porch_rafter_spacing_in: Read OC spacing for porch rafters. Typically 24" or 48".
- header_beam_size: Read header/beam size at top of posts from porch framing notes. Look for "4×8", "4×10", "4×12" beam callout.

═══════════════════════════════════════════
STEP 8 — DOORS (read door schedule and floor plan symbols)
═══════════════════════════════════════════
If a door schedule is present, read every line. If not, count symbols on floor plan.
For each door type, record:
- mark: Door mark/tag (D01, D02, etc.)
- count: How many of this type
- rough_opening_width_ft: RO width in feet (e.g., 3'-2" = 3.17)
- rough_opening_height_ft: RO height in feet (e.g., 6'-10" = 6.83)
- description: Door type description from schedule
- header: Header size callout if shown (e.g., "(2) 2×12")
- is_exterior: true if exterior door, false if interior
- is_double: true if double door or french doors

═══════════════════════════════════════════
STEP 9 — WINDOWS (read window schedule and floor plan symbols)
═══════════════════════════════════════════
For each window type:
- mark: Window mark (W01, W02, etc.)
- count: How many of this type
- rough_opening_width_ft: RO width in feet
- rough_opening_height_ft: RO height in feet
- description: Window type from schedule
- header: Header size if shown
- area_sf: rough_opening_width_ft × rough_opening_height_ft (calculate)
- is_egress: true if bedroom or egress window

═══════════════════════════════════════════
STEP 10 — TRUSSES (read truss schedule or framing plan)
═══════════════════════════════════════════
For each truss type:
- mark: Truss mark
- type: Truss type (gable, flat bottom, scissor, hip, valley, etc.)
- count: Quantity
- spacing_in: OC spacing (typically 24)
- span_ft: Truss span if shown
- description: Any additional notes

═══════════════════════════════════════════
STEP 11 — ROUGH TIMBER (read from framing schedules and elevation callouts)
═══════════════════════════════════════════
For each timber member:
- mark: Reference mark (R1, R2, etc.)
- size: Actual size (4×6, 6×6, 8×8, 2×12, LVL, etc.)
- count: Quantity
- length_ft: Length if shown
- description: Location and purpose (porch rafter, ridge beam, valley, king post, strut, etc.)

═══════════════════════════════════════════
STEP 12 — FOUNDATION (read from foundation plan and sections)
═══════════════════════════════════════════
- foundation_type: "monolithic_slab", "stem_wall", or "pier_beam"
- slab_thickness_in: Read from sections or foundation notes. Typically 4, 5, or 6 inches.
- thickened_edge_depth_in: Read from foundation section. Typically 12-18 inches.
- rebar_slab: Rebar spec for slab field if shown (e.g., "#4 @ 18 OC")
- rebar_beam: Rebar spec for edge beam if shown (e.g., "(3) #5 continuous")
- vapor_barrier: true if called out, false if not mentioned.
- gravel_base_in: Gravel sub-base thickness in inches if specified.

═══════════════════════════════════════════
STEP 13 — MATERIALS AND SPECS (read from general notes, wall sections, material schedule)
═══════════════════════════════════════════
- sheathing_type: Look for "OSB", "ZIP System", "ZIP", "oriented strand board" in wall sections or notes. Default "OSB".
- roofing_type: Look for roofing material callout. Default "Tuff-Rib 29ga".
- insulation_walls: Wall insulation spec if shown (e.g., "R-20 open cell spray foam", "R-21 batt").
- insulation_roof: Roof insulation spec if shown (e.g., "R-49 open cell spray foam").
- wainscot_type: "stone", "brick", "metal", or null. Look for wainscot callout on elevations.
- wainscot_height_ft: Wainscot height in feet if shown. Typically 3 or 4 feet.
- wainscot_walls: Which walls have wainscot — "front", "rear", "left", "right", or "all".
- exterior_finish: Primary exterior wall finish (metal panel, hardie, vinyl, etc.).

═══════════════════════════════════════════
STEP 14 — ROOMS AND SPACES (read room labels and dimensions from floor plan)
═══════════════════════════════════════════
List every labeled room with its dimensions if shown:
- rooms: array of { name, width_ft, depth_ft, sf } for each room

═══════════════════════════════════════════
STEP 15 — FLAGS AND NOTES
═══════════════════════════════════════════
- notes: Array of strings for anything that needs field verification, any discrepancies found between sheets, any items that were estimated rather than read directly, and any special conditions noted on the drawings.

═══════════════════════════════════════════
JSON OUTPUT — return this complete structure:
═══════════════════════════════════════════
{
  "project_name": null,
  "sheet_info": null,
  "sheets_identified": [],
  "living_sf": 0,
  "porch_sf": 0,
  "garage_sf": 0,
  "total_conditioned_sf": 0,
  "building_width_ft": 0,
  "building_depth_ft": 0,
  "plate_height_ft": 9,
  "ridge_height_ft": null,
  "porch_width_ft": 0,
  "porch_depth_ft": 0,
  "structural_roof_pitch": "6:12",
  "ceiling_pitch": null,
  "porch_pitch": "2:12",
  "eave_overhang_in": 16,
  "roof_type": "gable",
  "has_gable_popup": false,
  "gable_popup_width_ft": null,
  "gable_popup_pitch": null,
  "ext_wall_linear_ft": 0,
  "int_wall_linear_ft": 0,
  "plumbing_wall_linear_ft": 0,
  "ext_wall_net_sf": 0,
  "int_t_intersections": 0,
  "int_corner_count": 0,
  "blocking_lf": 0,
  "double_top_plate_lf": 0,
  "post_size": "8x8",
  "post_spacing_ft": 10,
  "porch_timber_spec": "STD",
  "porch_rafter_size": "2x6",
  "porch_rafter_spacing_in": 24,
  "header_beam_size": "4x8",
  "sheathing_type": "OSB",
  "roofing_type": "Tuff-Rib 29ga",
  "insulation_walls": null,
  "insulation_roof": null,
  "wainscot_type": null,
  "wainscot_height_ft": null,
  "wainscot_walls": null,
  "exterior_finish": "metal panel",
  "foundation_type": "monolithic_slab",
  "slab_thickness_in": 4,
  "thickened_edge_depth_in": 12,
  "rebar_slab": null,
  "rebar_beam": null,
  "vapor_barrier": true,
  "gravel_base_in": 4,
  "doors": [],
  "windows": [],
  "trusses": [],
  "rough_timber": [],
  "rooms": [],
  "notes": []
}

ABSOLUTE RULES:
1. Never fabricate numbers. Use 0 or null for fields you cannot find.
2. Never include porch SF in living_sf.
3. Read dimension strings directly — do not estimate from scale unless no dimensions exist.
4. If a door or window schedule exists, use it exactly. Do not recount from floor plan symbols if a schedule is present.
5. int_wall_linear_ft must reflect actual traced wall lengths — not a formula from SF.
6. If two sheets contradict each other, note it in the notes array and use the more detailed sheet.
7. Sanity check your numbers before responding: living_sf should be close to building_width × building_depth minus any unheated spaces. int_wall_linear_ft should be 15-25% of living_sf as a rough check.`;



// ─────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────

// Read schedules from a plan image (canvas capture)
app.post('/api/read-schedules', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'No image provided' });

    const prompt = `You are reading a residential construction plan. Your ONLY job is to read the schedules and labeled values on this page. Do not measure or estimate anything.

Read and return ONLY what you can see explicitly written:

1. DOOR SCHEDULE — read every row exactly as written
2. WINDOW SCHEDULE — read every row exactly as written  
3. TRUSS/FRAMING SCHEDULE — read every row exactly as written
4. SQFT SCHEDULE — read labeled SF values (living area, porch, etc.)
5. ROOF PITCH — read from elevation or framing plan pitch triangle
6. PLATE HEIGHT — read from elevation ("TOP OF WALL", "WALL HEIGHT", "PLATE HT")
7. PORCH PITCH — read from porch framing or elevation

Return ONLY valid JSON, no markdown:
{
  "living_sf": null,
  "porch_sf": null,
  "plate_height_ft": null,
  "structural_roof_pitch": null,
  "porch_pitch": null,
  "eave_overhang_in": null,
  "doors": [{"mark":"D01","count":1,"rough_opening_width_ft":3.0,"rough_opening_height_ft":6.83,"description":"","header":"(2) 2x12","is_exterior":true}],
  "windows": [{"mark":"W01","count":1,"rough_opening_width_ft":3.0,"rough_opening_height_ft":5.5,"description":"","header":"(2) 2x10","area_sf":16.5}],
  "trusses": [{"mark":"TR1","type":"flat bottom","count":12,"spacing_in":24,"description":""}],
  "notes": []
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: `API error: ${err}` });
    }

    const data = await response.json();
    const rawText = data.content.map(b => b.text || '').join('');

    let parsed;
    try {
      const clean = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      const first = rawText.indexOf('{');
      const last = rawText.lastIndexOf('}');
      if (first !== -1 && last !== -1) {
        parsed = JSON.parse(rawText.substring(first, last + 1));
      } else {
        return res.status(500).json({ error: 'Could not parse schedule data', raw: rawText.substring(0, 200) });
      }
    }

    res.json(parsed);
  } catch (err) {
    console.error('read-schedules error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Analyze drawing
app.post('/api/analyze', upload.single('drawing'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

    const fileBuffer = req.file.buffer;
    const mimeType = req.file.mimetype;

    // Build content blocks
    // PDFs: send as native document block — Anthropic extracts text + image per page at full fidelity
    // Images: send as image block
    let contentBlocks = [];
    const base64Data = fileBuffer.toString('base64');

    if (mimeType === 'application/pdf') {
      console.log(`PDF upload: ${req.file.originalname} — ${Math.round(fileBuffer.length/1024)}KB — sending natively`);
      contentBlocks = [{
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: base64Data
        }
      }];
    } else {
      const validType = ['image/jpeg','image/png','image/gif','image/webp'].includes(mimeType)
        ? mimeType : 'image/jpeg';
      contentBlocks = [{ type: 'image', source: { type: 'base64', media_type: validType, data: base64Data } }];
    }

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    };

    // ── CALL 1: Chain-of-thought wall measurement pass ──
    // Ask Claude to narrate every wall segment out loud before producing JSON.
    // This forces explicit spatial reasoning instead of guessing totals.
    const measurePrompt = `You are reading a residential floor plan. Before doing anything else, I need you to carefully trace and measure every wall on this plan.

Work through the plan systematically:

1. EXTERIOR WALLS — trace the full perimeter. List each wall segment with its dimension string. Example: "North wall: 58'-0". East wall: 38'-0"..." Sum them for total ext_wall_linear_ft.

2. INTERIOR PARTITION WALLS ONLY — count walls that have rooms on BOTH sides. Do NOT count exterior walls even if they are a room boundary. Go room by room and list only the walls shared between two interior spaces. Example: "Wall between master bedroom and master bath: 12'-0". Wall between hallway and bedroom 2: 11'-5"..." Never count the same wall twice. Sum for int_wall_linear_ft.

3. PLUMBING WALLS — identify every wall directly adjacent to a toilet, tub, shower, sink, washer, or water heater. List each one with its length.

4. SQUARE FOOTAGE — read the SqFt schedule or title block directly. State the exact number shown for living area and porch area.

5. KEY DIMENSIONS — state building width, building depth, plate height, porch width, porch depth, roof pitch.

6. DOOR & WINDOW SCHEDULE — read every line of the schedule if present. List mark, count, size, header.

Be precise. Read every dimension string you can see. Do not estimate.`;

    const call1Response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        messages: [{ role: 'user', content: [...contentBlocks, { type: 'text', text: measurePrompt }] }]
      })
    });

    if (!call1Response.ok) {
      const err = await call1Response.text();
      console.error('Call 1 API error:', err);
      return res.status(500).json({ error: `API error: ${err}` });
    }

    const call1Data = await call1Response.json();
    const measurement_narration = call1Data.content.map(b => b.text || '').join('');
    console.log('Call 1 narration length:', measurement_narration.length);
    console.log('Narration preview:', measurement_narration.substring(0, 300));

    // ── CALL 2: Convert narration + images into final JSON ──
    const call2Messages = [
      { role: 'user', content: [...contentBlocks, { type: 'text', text: measurePrompt }] },
      { role: 'assistant', content: measurement_narration },
      { role: 'user', content: [{ type: 'text', text: EXTRACTION_PROMPT }] }
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: call2Messages
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Call 2 API error:', err);
      return res.status(500).json({ error: `API error: ${err}` });
    }

    const data = await response.json();
    console.log('Call 2 response types:', data.content?.map(b=>b.type));
    const rawText = data.content.map(b => b.text || '').join('');
    console.log('Raw JSON length:', rawText.length, 'Preview:', rawText.substring(0,200));
    if (!rawText || rawText.length < 10) {
      return res.status(500).json({ error: 'AI returned empty response. Try a higher resolution image.' });
    }

    // Parse JSON from response — robust extraction regardless of markdown wrapping
    let extracted;
    let parseError = null;

    // Strategy 1: strip markdown fences
    try {
      const clean = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      extracted = JSON.parse(clean);
    } catch (e1) {
      parseError = e1.message;
    }

    // Strategy 2: find first { and last } and extract just that substring
    if (!extracted) {
      try {
        const first = rawText.indexOf('{');
        const last = rawText.lastIndexOf('}');
        if (first !== -1 && last !== -1 && last > first) {
          extracted = JSON.parse(rawText.substring(first, last + 1));
        }
      } catch (e2) {
        parseError = e2.message;
      }
    }

    // Strategy 3: ask Claude to fix the malformed JSON
    if (!extracted) {
      try {
        console.log('Strategies 1+2 failed, asking Claude to repair JSON...');
        const repairResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 4096,
            messages: [{
              role: 'user',
              content: `The following text is supposed to be a valid JSON object but has a syntax error. Fix it and return ONLY the corrected JSON with no markdown, no explanation, nothing else:\n\n${rawText.substring(0, 8000)}`
            }]
          })
        });
        if (repairResponse.ok) {
          const repairData = await repairResponse.json();
          const repairText = repairData.content.map(b => b.text || '').join('').trim();
          const first = repairText.indexOf('{');
          const last = repairText.lastIndexOf('}');
          if (first !== -1 && last !== -1) {
            extracted = JSON.parse(repairText.substring(first, last + 1));
            console.log('JSON repair succeeded');
          }
        }
      } catch (e3) {
        parseError = e3.message;
      }
    }

    if (!extracted) {
      console.error('All JSON parse strategies failed:', parseError, 'Raw:', rawText.substring(0, 400));
      return res.status(500).json({
        error: 'Could not parse drawing data — the AI response was not valid JSON. Try a clearer image.',
        raw: rawText.substring(0, 300)
      });
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
