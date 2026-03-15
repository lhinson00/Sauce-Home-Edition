require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// File upload — store in memory, max 20MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
    cb(null, allowed.includes(file.mimetype));
  }
});

// ─────────────────────────────────────────────
// ASSEMBLY RULES ENGINE
// ─────────────────────────────────────────────

function runRulesEngine(extracted) {
  const results = { categories: [], flags: [], summary: {} };

  const {
    living_sf = 0,
    porch_sf = 0,
    building_width_ft = 0,
    building_depth_ft = 0,
    plate_height_ft = 9,
    structural_roof_pitch = '6:12',
    ceiling_pitch = null,
    porch_pitch = '2:12',
    ext_wall_linear_ft = 0,
    int_wall_linear_ft = 0,
    plumbing_wall_linear_ft = 0,
    exterior_corners = 4,
    int_t_intersections = 0,
    doors = [],
    windows = [],
    trusses = [],
    rough_timber = [],
    sheathing_type = 'OSB',
    roofing_type = 'Tuff-Rib 29ga',
    eave_overhang_in = 16,
    roof_area_main_sf = 0,
    roof_area_porch_sf = 0,
    foundation_type = 'monolithic_slab',
    slab_thickness_in = 4
  } = extracted;

  // Flag if ceiling pitch differs from structural pitch
  if (ceiling_pitch && ceiling_pitch !== structural_roof_pitch) {
    results.flags.push({
      level: 'warning',
      message: `Floor plan shows ${ceiling_pitch} ceiling pitch (interior vault). Structural roof pitch from elevation is ${structural_roof_pitch}. All sheathing and roofing quantities calculated at ${structural_roof_pitch}. Confirm with engineer before ordering.`
    });
  }

  // Pitch multiplier table
  const pitchMultipliers = {
    '2:12': 1.014, '3:12': 1.031, '4:12': 1.054, '5:12': 1.083,
    '6:12': 1.118, '7:12': 1.158, '8:12': 1.202, '10:12': 1.302, '12:12': 1.414
  };

  const mainMult = pitchMultipliers[structural_roof_pitch] || 1.118;
  const porchMult = pitchMultipliers[porch_pitch] || 1.014;
  const overhangFt = eave_overhang_in / 12;

  // Calculate actual sloped roof areas
  const mainFootprint = building_width_ft * building_depth_ft;
  const mainWithOverhang = mainFootprint + (building_width_ft * overhangFt * 2) + (building_depth_ft * overhangFt * 2);
  const mainSlopedSF = Math.round(mainWithOverhang * mainMult);
  const porchWithOverhang = porch_sf + (building_width_ft * overhangFt);
  const porchSlopedSF = Math.round(porchWithOverhang * porchMult);
  const totalSlopedSF = mainSlopedSF + porchSlopedSF;

  const totalSlabSF = living_sf + porch_sf;
  const perimeterLF = (building_width_ft + building_depth_ft) * 2;
  const netWallSF = (ext_wall_linear_ft * plate_height_ft) * 0.85; // ~15% deducted for openings

  // ─── FOUNDATION ───
  const slabThicknessFt = slab_thickness_in / 12;
  const slabCY = Math.ceil((totalSlabSF * slabThicknessFt / 27) * 1.1);
  const edgeBeamCY = Math.ceil((perimeterLF * 1.0 * 1.5 / 27) * 1.1);
  const totalConcreteCY = slabCY + edgeBeamCY;
  const rebarSlabLF = Math.ceil((totalSlabSF / 1.5) * 2 * 1.1);
  const rebarBeamLF = Math.ceil(perimeterLF * 3 * 1.1);
  const vaporBarrierSF = Math.ceil(totalSlabSF * 1.15);
  const gravelCY = Math.ceil(totalSlabSF * (4/12) / 27);

  results.categories.push({
    name: 'Foundation',
    color: '#2E4057',
    items: [
      { item: 'Concrete — slab + edge beam', description: `Monolithic ${slab_thickness_in}" slab + thickened edge`, qty: totalConcreteCY, unit: 'CY', confidence: 'high' },
      { item: 'Rebar — slab field', description: '#4 @ 18" OC both directions', qty: rebarSlabLF.toLocaleString(), unit: 'LF', confidence: 'high' },
      { item: 'Rebar — edge beam', description: '(3) #5 continuous', qty: rebarBeamLF, unit: 'LF', confidence: 'high' },
      { item: 'Vapor barrier', description: '6 mil poly under slab', qty: vaporBarrierSF.toLocaleString(), unit: 'SF', confidence: 'high' },
      { item: 'Gravel base', description: '4" compacted sub-base', qty: gravelCY, unit: 'CY', confidence: 'high' },
    ]
  });

  // ─── EXTERIOR WALL FRAMING ───
  const extStudCount = Math.ceil((ext_wall_linear_ft / 1.333) + exterior_corners * 3);
  const extTopPlateLF = Math.ceil(ext_wall_linear_ft * 2 * 1.1);
  const extBotPlateLF = Math.ceil(ext_wall_linear_ft * 1.1);
  const wallSheathingSheets = Math.ceil((ext_wall_linear_ft * plate_height_ft / 32) * 1.1);
  const houseWrapSF = Math.ceil(ext_wall_linear_ft * plate_height_ft * 1.15);

  // Headers from door/window schedule
  const headerItems = {};
  [...doors, ...windows].forEach(item => {
    const hdr = item.header || '(2) 2x6';
    const len = Math.ceil((item.rough_opening_width_ft || 3) + 0.5);
    if (!headerItems[hdr]) headerItems[hdr] = 0;
    headerItems[hdr] += len;
  });

  const extFramingItems = [
    { item: 'Studs — 2×6 exterior', description: `104-5/8" precut @ 16" OC`, qty: extStudCount, unit: 'EA', confidence: 'high' },
    { item: 'Top plate — 2×6', description: 'Double top plate + 10% waste', qty: extTopPlateLF, unit: 'LF', confidence: 'high' },
    { item: 'Bottom plate — 2×6 PT', description: 'Single PT sill plate', qty: extBotPlateLF, unit: 'LF', confidence: 'high' },
  ];

  Object.entries(headerItems).forEach(([hdr, lf]) => {
    extFramingItems.push({ item: `Headers — ${hdr}`, description: 'Per door/window schedule', qty: Math.ceil(lf), unit: 'LF', confidence: 'high' });
  });

  if (sheathing_type === 'ZIP') {
    extFramingItems.push({ item: 'Wall sheathing — ZIP System', description: '4×8 panels + ZIP tape', qty: wallSheathingSheets, unit: 'SHEETS', confidence: 'high' });
    extFramingItems.push({ item: 'ZIP tape', description: '1 roll per 100 LF of seams', qty: Math.ceil(ext_wall_linear_ft / 100), unit: 'ROLLS', confidence: 'high' });
  } else {
    extFramingItems.push({ item: 'Wall sheathing — OSB 7/16"', description: '4×8 sheets + 10% waste', qty: wallSheathingSheets, unit: 'SHEETS', confidence: 'high' });
    extFramingItems.push({ item: 'House wrap', description: 'Per wall SF + 15% overlap', qty: houseWrapSF.toLocaleString(), unit: 'SF', confidence: 'high' });
  }

  results.categories.push({ name: 'Exterior Wall Framing — 2×6 @ 16" OC', color: '#1F4E79', items: extFramingItems });

  // ─── INTERIOR WALL FRAMING ───
  const intStudCount = Math.ceil(int_wall_linear_ft / 1.333);
  const plumbStudCount = Math.ceil(plumbing_wall_linear_ft / 1.333);
  const intPlateLF = Math.ceil((int_wall_linear_ft + plumbing_wall_linear_ft) * 3 * 1.1);
  const ladderBlockingLF = Math.ceil(int_t_intersections * 3.5);

  if (plumbing_wall_linear_ft > 0) {
    results.flags.push({
      level: 'info',
      message: `${plumbing_wall_linear_ft} LF of plumbing walls detected (bathroom/laundry). Framed as 2×6 @ 16" OC. Confirm all wet wall locations before ordering.`
    });
  }

  results.categories.push({
    name: 'Interior Wall Framing',
    color: '#2E5984',
    items: [
      { item: 'Studs — 2×4 standard', description: '92-5/8" precut @ 16" OC', qty: intStudCount, unit: 'EA', confidence: 'high' },
      { item: 'Studs — 2×6 plumbing walls', description: '92-5/8" precut @ 16" OC', qty: plumbStudCount, unit: 'EA', confidence: 'medium' },
      { item: 'Plates — interior', description: 'Double top + single bottom', qty: intPlateLF, unit: 'LF', confidence: 'high' },
      { item: 'Ladder blocking', description: '2×4 flat at T-intersections', qty: ladderBlockingLF || 'Verify', unit: 'LF', confidence: 'medium' },
    ]
  });

  // ─── ROOF FRAMING ───
  const roofFramingItems = [];

  if (trusses.length > 0) {
    trusses.forEach(t => {
      roofFramingItems.push({ item: `${t.type} (${t.mark})`, description: t.description || '24" OC spacing', qty: t.count, unit: 'EA', confidence: 'high' });
    });
  } else {
    const totalTrusses = Math.ceil(building_width_ft / 2) + 1;
    roofFramingItems.push({ item: 'Trusses — calculated', description: '24" OC — confirm type with engineer', qty: totalTrusses, unit: 'EA', confidence: 'medium' });
  }

  if (rough_timber.length > 0) {
    rough_timber.forEach(r => {
      roofFramingItems.push({ item: `Rough timber ${r.size} (${r.mark})`, description: r.description || 'Per framing schedule', qty: r.count, unit: 'EA', confidence: 'high' });
    });
  }

  const ridgeNailerLF = Math.ceil(building_width_ft * 1.1);
  const purlinLF = Math.ceil((mainSlopedSF / 2) * 1.1);
  const porchDeckLF = Math.ceil((porch_sf / 0.833) * 1.1);
  const fasciaLF = Math.ceil(perimeterLF * 1.1);

  roofFramingItems.push(
    { item: 'Ridge nailer — 2×12 #2 SP', description: 'Building length + 10% waste', qty: ridgeNailerLF, unit: 'LF', confidence: 'high' },
    { item: 'Purlins — 2×4 #2 SP', description: '@ 24" OC on truss top chords', qty: purlinLF.toLocaleString(), unit: 'LF', confidence: 'high' },
    { item: 'Porch decking — 2×6 T&G', description: 'Solid decking + 10% waste', qty: porchDeckLF, unit: 'LF', confidence: 'high' },
    { item: 'Fascia — 2×6 #2 SP', description: 'Eave perimeter + 10%', qty: fasciaLF, unit: 'LF', confidence: 'high' }
  );

  results.categories.push({ name: 'Roof Framing', color: '#4A2040', items: roofFramingItems });

  // ─── ROOF SHEATHING + COVERING ───
  const roofSheathSheets = Math.ceil((totalSlopedSF / 32) * 1.1);
  const metalRoofingLF = Math.ceil((totalSlopedSF / 3) * 1.1);
  const ridgeCapLF = Math.ceil(building_width_ft * 1.1);
  const eavesTrimLF = Math.ceil(perimeterLF * 1.1);

  const roofCoverItems = [
    { item: `Roof sheathing — ${sheathing_type === 'ZIP' ? 'ZIP System' : 'OSB 7/16"'}`, description: `${totalSlopedSF.toLocaleString()} SF sloped + 10% waste`, qty: roofSheathSheets, unit: 'SHEETS', confidence: 'high' },
  ];

  if (sheathing_type !== 'ZIP') {
    roofCoverItems.push({ item: 'Underlayment — synthetic', description: 'Full roof area', qty: totalSlopedSF.toLocaleString(), unit: 'SF', confidence: 'high' });
  } else {
    roofCoverItems.push({ item: 'ZIP tape — roof', description: 'Seam sealing', qty: Math.ceil(totalSlopedSF / 100), unit: 'ROLLS', confidence: 'high' });
  }

  roofCoverItems.push(
    { item: `Metal roofing — ${roofing_type}`, description: '3\' coverage panels + 10% waste', qty: metalRoofingLF.toLocaleString(), unit: 'LF', confidence: 'high' },
    { item: 'Ridge cap — metal', description: 'Main ridge + 10%', qty: ridgeCapLF, unit: 'LF', confidence: 'high' },
    { item: 'Eave trim / drip edge', description: 'Eave perimeter + 10%', qty: eavesTrimLF, unit: 'LF', confidence: 'high' }
  );

  results.categories.push({ name: 'Roof Sheathing + Covering', color: '#3A2010', items: roofCoverItems });

  // ─── EXTERIOR SIDING + FINISHES ───
  const sidingLF = Math.ceil((netWallSF / 3) * 1.1);
  const soffitSF = Math.ceil(perimeterLF * overhangFt);
  const cornerTrimLF = Math.ceil(exterior_corners * plate_height_ft * 1.1);
  const openingTrimLF = Math.ceil([...doors, ...windows].reduce((acc, o) => {
    const w = o.rough_opening_width_ft || 3;
    const h = o.rough_opening_height_ft || 6.67;
    return acc + (w + h) * 2;
  }, 0) * 1.1);

  results.categories.push({
    name: 'Exterior Siding + Finishes',
    color: '#1A4030',
    items: [
      { item: 'Metal siding — Tuff-Rib 29ga', description: '3\' panels, net wall area + 10%', qty: sidingLF.toLocaleString(), unit: 'LF', confidence: 'high' },
      { item: 'Metal soffit', description: 'Panel match — eave coverage', qty: soffitSF, unit: 'SF', confidence: 'medium' },
      { item: 'Corner trim', description: 'All exterior corners', qty: cornerTrimLF, unit: 'LF', confidence: 'high' },
      { item: 'Window / door trim', description: 'All opening perimeters', qty: openingTrimLF || 'Per schedule', unit: 'LF', confidence: 'high' },
    ]
  });

  // ─── INSULATION ───
  const wallFoamBF = Math.ceil(netWallSF * 5.5 * 1.1);
  const roofFoamBF = Math.ceil(totalSlopedSF * 13.2 * 1.1);

  results.categories.push({
    name: 'Insulation — Open-Cell Spray Foam',
    color: '#1A3A2A',
    items: [
      { item: 'Spray foam — walls', description: 'Open-cell, 2×6 full cavity, R-20', qty: wallFoamBF.toLocaleString(), unit: 'BF', confidence: 'high' },
      { item: 'Spray foam — roof', description: 'Open-cell, R-49 @ 13.2" depth', qty: roofFoamBF.toLocaleString(), unit: 'BF', confidence: 'high' },
    ]
  });

  // SUMMARY
  results.summary = {
    living_sf,
    porch_sf,
    total_slab_sf: totalSlabSF,
    main_sloped_sf: mainSlopedSF,
    porch_sloped_sf: porchSlopedSF,
    total_sloped_sf: totalSlopedSF,
    building_dimensions: `${building_width_ft}' × ${building_depth_ft}'`,
    plate_height: `${plate_height_ft}'-0"`,
    structural_roof_pitch,
    porch_pitch,
    total_doors: doors.length,
    total_windows: windows.length,
    total_glazing_sf: windows.reduce((a, w) => a + (w.area_sf || 0), 0),
    sheathing_type,
    foundation_type
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
    const base64Data = fileBuffer.toString('base64');

    // Build message for Claude
    const messages = [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mimeType === 'application/pdf' ? 'image/png' : mimeType,
            data: base64Data
          }
        },
        { type: 'text', text: EXTRACTION_PROMPT }
      ]
    }];

    // For PDFs, use document type
    if (mimeType === 'application/pdf') {
      messages[0].content[0] = {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: base64Data
        }
      };
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
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

// Serve frontend for all other routes
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`HomeBuild AI running on port ${PORT}`));
