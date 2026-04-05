/**
 * server/search.js
 *
 * Zero-configuration natural-language search over locally synced pins and videos.
 * No API keys. No external calls. Runs entirely offline.
 *
 * Pipeline per query:
 *   1. Tokenise + stem the query (suffix-stripping, handles plurals, -ing, -ist, -ism, etc.)
 *   2. Expand each token against a large built-in creative vocabulary (concept clusters)
 *   3. Score every item by field-weighted exact, stemmed, fuzzy, and expansion hits
 *   4. Bonus when a single item activates multiple distinct concept clusters
 *   5. Return top-N sorted by score
 *
 * The vocabulary covers: aesthetics, movements, moods, colour, texture, light, medium,
 * typography, photography, film, fashion, architecture, geography, and more.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = join(__dirname, '..', 'data');

// ─────────────────────────────────────────────────────────────────────────────
// Stemmer — aggressive suffix-stripping, min stem length 3
// Longest suffix wins so we don't over-strip
// ─────────────────────────────────────────────────────────────────────────────

const SUFFIXES = [
  'istically', 'ization', 'isation', 'ational', 'nesses', 'nesses',
  'alism', 'alist', 'ating', 'ation', 'itive', 'istic', 'izing',
  'ising', 'iness', 'ness', 'ment', 'tion', 'sion', 'ism', 'ist',
  'ful', 'ing', 'ity', 'ous', 'ive', 'ize', 'ise', 'ial', 'ied',
  'ier', 'ies', 'ily', 'al', 'ic', 'er', 'ed', 'ly', 'es', 's',
];

export function stem(word) {
  if (word.length <= 4) return word;
  for (const sfx of SUFFIXES) {
    if (word.endsWith(sfx)) {
      const root = word.slice(0, word.length - sfx.length);
      if (root.length >= 3) return root;
    }
  }
  return word;
}

// ─────────────────────────────────────────────────────────────────────────────
// Levenshtein edit distance (for fuzzy matching short words)
// ─────────────────────────────────────────────────────────────────────────────

function editDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const curr = a[i - 1] === b[j - 1]
        ? row[j - 1]
        : Math.min(row[j - 1], row[j], prev) + 1;
      row[j - 1] = prev;
      prev = curr;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

// Max allowed edits: 1 for words 5–7 chars, 2 for 8+ chars
function fuzzyMatchScore(query, term) {
  if (query === term) return 1;
  const minLen = Math.min(query.length, term.length);
  if (minLen < 5) return 0;
  const maxEdits = minLen >= 8 ? 2 : 1;
  const d = editDistance(query, term);
  if (d > maxEdits) return 0;
  return 1 - (d / (minLen + 1)); // 0.8–0.95 for near misses
}

// ─────────────────────────────────────────────────────────────────────────────
// Creative vocabulary — concept clusters
//
// Each cluster is a group of related terms that should activate together.
// When a query word matches any term in a cluster, all other terms in that
// cluster are added to the expanded query at a lower weight.
//
// Organised into thematic sections. Add clusters freely — no other code changes.
// ─────────────────────────────────────────────────────────────────────────────

const CONCEPT_CLUSTERS = [

  // ── MINIMALISM ──────────────────────────────────────────────────────────────
  ['minimal', 'minimalist', 'minimalism', 'clean', 'simple', 'spare', 'sparse',
   'empty', 'quiet', 'restrained', 'stripped', 'bare', 'lean', 'pared', 'reductive',
   'neutral', 'subtle', 'understated', 'uncluttered', 'negative space', 'whitespace',
   'monastic', 'austere', 'ascetic', 'void'],

  // ── LUXURY / EXPENSIVE ─────────────────────────────────────────────────────
  ['expensive', 'luxury', 'luxurious', 'premium', 'high-end', 'opulent', 'sumptuous',
   'lavish', 'sophisticated', 'refined', 'elegant', 'upscale', 'boutique', 'bespoke',
   'couture', 'prestige', 'exclusive', 'elite', 'tasteful', 'well-appointed',
   'polished', 'impeccable', 'curated', 'quality', 'artisanal'],

  // ── BRUTALISM ───────────────────────────────────────────────────────────────
  ['brutal', 'brutalist', 'brutalism', 'raw', 'concrete', 'stark', 'harsh',
   'industrial', 'heavy', 'monolithic', 'geometric', 'exposed', 'utilitarian',
   'soviet', 'soviet-era', 'constructivist', 'unfinished', 'coarse', 'blunt',
   'imposing', 'fortress', 'blocky', 'angular', 'massive'],

  // ── EDITORIAL / FASHION ────────────────────────────────────────────────────
  ['editorial', 'magazine', 'fashion', 'lookbook', 'campaign', 'studio',
   'styled', 'glossy', 'vogue', 'runway', 'haute', 'spread', 'shoot',
   'couture', 'collection', 'season', 'model', 'pose', 'garment', 'wardrobe',
   'stylist', 'art direction', 'concept shoot'],

  // ── CINEMATIC ───────────────────────────────────────────────────────────────
  ['cinematic', 'film', 'movie', 'atmospheric', 'dramatic', 'widescreen',
   'anamorphic', 'frame', 'scene', 'still', 'cinematography', 'mise en scène',
   'depth of field', 'bokeh', 'lens flare', 'rack focus', 'long take',
   'wide angle', 'close-up', 'establishing shot'],

  // ── MOODY / DARK ────────────────────────────────────────────────────────────
  ['moody', 'dark', 'shadow', 'noir', 'brooding', 'dramatic', 'deep', 'rich',
   'gothic', 'chiaroscuro', 'contrast', 'mysterious', 'ominous', 'murky',
   'tenebrous', 'dim', 'night', 'underexposed', 'low key', 'sinister',
   'melancholic', 'somber', 'grave'],

  // ── WARM / EARTHY ───────────────────────────────────────────────────────────
  ['warm', 'earthy', 'amber', 'golden', 'terracotta', 'ochre', 'rust',
   'clay', 'sand', 'autumn', 'sienna', 'umber', 'honey', 'caramel', 'tawny',
   'sepia', 'sun-baked', 'desert', 'harvest', 'wood', 'stone', 'brick'],

  // ── COOL / COLD ─────────────────────────────────────────────────────────────
  ['cold', 'cool', 'icy', 'frost', 'steel', 'slate', 'silver', 'blue-grey',
   'nordic', 'winter', 'crisp', 'clinical', 'sterile', 'glacial', 'stark',
   'overcast', 'grey', 'concrete', 'bleached'],

  // ── RETRO / VINTAGE ─────────────────────────────────────────────────────────
  ['retro', 'vintage', 'nostalgic', 'analog', 'grain', 'faded', 'aged',
   'classic', 'throwback', 'patina', 'weathered', 'antique', 'archival',
   'period', 'bygone', '70s', '80s', '90s', 'mid-century', 'kodachrome',
   'ektachrome', 'polaroid', 'vhs', 'super8', 'daguerreotype'],

  // ── PLAYFUL / VIBRANT ───────────────────────────────────────────────────────
  ['playful', 'fun', 'colorful', 'colourful', 'bright', 'vibrant', 'energetic',
   'lively', 'quirky', 'whimsical', 'joyful', 'exuberant', 'cheerful', 'buoyant',
   'pop', 'loud', 'kitschy', 'campy', 'maximalist', 'kaleidoscopic'],

  // ── ORGANIC / NATURAL ───────────────────────────────────────────────────────
  ['natural', 'organic', 'nature', 'botanical', 'plant', 'floral', 'green',
   'outdoor', 'landscape', 'wabi-sabi', 'imperfect', 'handmade', 'craft',
   'artisan', 'foraged', 'wild', 'overgrown', 'garden', 'forest', 'terrain'],

  // ── GRAPHIC / GEOMETRIC ─────────────────────────────────────────────────────
  ['graphic', 'geometric', 'bold', 'flat', 'shape', 'pattern', 'grid',
   'modular', 'systematic', 'poster', 'swiss', 'bauhaus', 'constructivism',
   'de stijl', 'structured', 'angular', 'vector', 'diagram', 'infographic'],

  // ── SOFT / DREAMY ───────────────────────────────────────────────────────────
  ['soft', 'dreamy', 'hazy', 'ethereal', 'delicate', 'gentle', 'tender',
   'pastel', 'blush', 'gossamer', 'gauzy', 'mist', 'fog', 'diffuse',
   'romantic', 'impressionist', 'painterly', 'watercolor', 'airy', 'floaty'],

  // ── FUTURISTIC / TECH ───────────────────────────────────────────────────────
  ['futuristic', 'tech', 'digital', 'cyber', 'neon', 'glitch', 'chrome',
   'metallic', 'space', 'sci-fi', 'speculative', 'dystopian', 'utopian',
   'synthetic', 'rendered', '3d', 'cgi', 'ai', 'matrix', 'vaporwave',
   'cyberpunk', 'y2k', 'pixel'],

  // ── STREET / URBAN ──────────────────────────────────────────────────────────
  ['street', 'urban', 'city', 'gritty', 'documentary', 'candid', 'snapshot',
   'reportage', 'guerrilla', 'graffiti', 'underground', 'subculture',
   'zine', 'punk', 'lo-fi', 'raw', 'unposed', 'real'],

  // ── ARCHITECTURE / SPACE ────────────────────────────────────────────────────
  ['architecture', 'architectural', 'interior', 'space', 'room', 'building',
   'structure', 'form', 'volume', 'ceiling', 'floor', 'wall', 'facade',
   'section', 'plan', 'elevation', 'detail', 'material', 'light and shadow'],

  // ── TYPOGRAPHY ──────────────────────────────────────────────────────────────
  ['typography', 'type', 'typeface', 'font', 'lettering', 'serif', 'sans-serif',
   'grotesque', 'geometric', 'script', 'display', 'blackletter', 'slab',
   'calligraphy', 'hand-lettered', 'logotype', 'wordmark', 'headline',
   'body copy', 'kerning', 'leading', 'hierarchy'],

  // ── PORTRAITURE ─────────────────────────────────────────────────────────────
  ['portrait', 'face', 'headshot', 'close-up', 'gaze', 'expression',
   'character', 'person', 'figure', 'silhouette', 'profile', 'bust',
   'candid', 'posed', 'identity', 'selfie', 'self-portrait'],

  // ── LANDSCAPE / ENVIRONMENT ─────────────────────────────────────────────────
  ['landscape', 'seascape', 'skyscape', 'terrain', 'horizon', 'vista',
   'panorama', 'wilderness', 'remote', 'sublime', 'vast', 'open', 'empty',
   'aerial', 'topographic', 'geographic'],

  // ── STILL LIFE / PRODUCT ────────────────────────────────────────────────────
  ['still life', 'product', 'object', 'arrangement', 'composition',
   'tabletop', 'flatlay', 'overhead', 'texture', 'material', 'surface',
   'packaging', 'label', 'prop', 'detail shot', 'macro'],

  // ── BLACK AND WHITE ─────────────────────────────────────────────────────────
  ['black and white', 'monochrome', 'greyscale', 'grayscale', 'desaturated',
   'tonal', 'high contrast', 'silver gelatin', 'zone system', 'duotone',
   'monotone', 'achromatic'],

  // ── FILM PHOTOGRAPHY ────────────────────────────────────────────────────────
  ['film', 'analog', 'grain', '35mm', '120', 'medium format', 'large format',
   'darkroom', 'developing', 'negative', 'slide', 'chrome', 'kodak',
   'fuji', 'ilford', 'leica', 'hasselblad', 'rollei', 'expired'],

  // ── COLOUR PALETTES ─────────────────────────────────────────────────────────
  ['muted', 'desaturated', 'dusty', 'chalky', 'faded', 'washed out', 'toned',
   'low saturation', 'subtle colour', 'understated palette'],

  ['saturated', 'vivid', 'high chroma', 'punchy', 'electric', 'neon',
   'fluorescent', 'iridescent', 'chromatic', 'full spectrum'],

  ['monochromatic', 'tonal', 'tone-on-tone', 'single hue', 'analogous',
   'harmonic', 'restrained palette'],

  ['earth tones', 'neutral', 'natural palette', 'warm neutral', 'cool neutral',
   'off-white', 'cream', 'ecru', 'linen', 'taupe', 'greige', 'beige'],

  // ── LIGHT ───────────────────────────────────────────────────────────────────
  ['golden hour', 'magic hour', 'dusk', 'dawn', 'sunrise', 'sunset',
   'warm light', 'directional light', 'raking light', 'side light'],

  ['blue hour', 'twilight', 'ambient', 'cool light', 'overcast', 'diffuse',
   'soft box', 'window light', 'north light'],

  ['harsh light', 'direct sun', 'midday', 'bleached', 'high key',
   'overexposed', 'blown out', 'glare', 'specular'],

  ['low light', 'night', 'available light', 'practical light', 'neon',
   'candle', 'firelight', 'lamp', 'interior light', 'tungsten', 'orange glow'],

  ['flash', 'strobe', 'ring light', 'on camera', 'editorial light',
   'fashion lighting', 'beauty dish', 'hard shadow'],

  // ── TEXTURE / MATERIAL ──────────────────────────────────────────────────────
  ['rough', 'textured', 'tactile', 'surface', 'grain', 'grunge', 'worn',
   'distressed', 'scratched', 'cracked', 'peeling', 'layered', 'collage'],

  ['smooth', 'glossy', 'shiny', 'lacquer', 'gloss', 'reflective', 'polished',
   'mirror', 'glass', 'ceramic', 'porcelain', 'lacquered'],

  ['matte', 'flat', 'chalky', 'powdery', 'velvet', 'suede', 'uncoated',
   'paper', 'cardstock', 'newsprint', 'craft'],

  ['fabric', 'textile', 'woven', 'knit', 'linen', 'cotton', 'silk', 'wool',
   'denim', 'leather', 'canvas', 'drape', 'fold', 'crease', 'pleat'],

  // ── GEOGRAPHIC / CULTURAL ───────────────────────────────────────────────────
  ['scandinavian', 'nordic', 'swedish', 'danish', 'norwegian', 'finnish',
   'hygge', 'lagom', 'nordic minimalism', 'ikea aesthetic'],

  ['japanese', 'japan', 'tokyo', 'wabi-sabi', 'zen', 'ma', 'ikebana',
   'ukiyo-e', 'manga', 'anime', 'harajuku', 'kintsugi', 'shibori'],

  ['italian', 'italy', 'mediterranean', 'roman', 'baroque', 'renaissance',
   'dolce vita', 'alessi', 'olivetti', 'fiat', 'vespa'],

  ['american', 'americana', 'vernacular', 'roadside', 'diner', 'midwest',
   'new england', 'southwest', 'west coast', 'nyc', 'la'],

  ['french', 'paris', 'parisian', 'french new wave', 'gauche', 'bobo',
   'café', 'boulevard', 'riviera', 'cinema vérité'],

  ['african', 'west african', 'east african', 'afrofuturism', 'kente',
   'ankara', 'afrobeats', 'lagos', 'nairobi'],

  ['latin', 'south american', 'mexican', 'caribbean', 'tropical', 'vibrant',
   'magical realism', 'muralism', 'folk art', 'textiles'],

  // ── ART MOVEMENTS ───────────────────────────────────────────────────────────
  ['bauhaus', 'functionalism', 'form follows function', 'modernism', 'modern',
   'international style', 'swiss design', 'ulm school'],

  ['art nouveau', 'jugendstil', 'ornamental', 'organic form', 'floral',
   'decorative', 'sinuous', 'fin de siècle', 'mucha'],

  ['art deco', 'deco', 'streamline', 'geometric ornament', 'jazz age',
   'gatsby', 'prohibition', 'skyscraper', 'chrysler'],

  ['surrealism', 'surrealist', 'dreamlike', 'uncanny', 'juxtaposition',
   'subconscious', 'dali', 'magritte', 'ernst', 'strange', 'impossible'],

  ['pop art', 'pop', 'andy warhol', 'lichtenstein', 'consumer culture',
   'mass production', 'celebrity', 'advertising', 'screen print'],

  ['impressionism', 'impressionist', 'painterly', 'loose', 'gestural',
   'light and colour', 'plein air', 'monet', 'renoir'],

  ['expressionism', 'expressionist', 'distorted', 'emotional', 'raw emotion',
   'subjective', 'egon schiele', 'kirchner', 'munch'],

  // ── DESIGN DISCIPLINES ──────────────────────────────────────────────────────
  ['branding', 'brand', 'identity', 'logo', 'mark', 'system', 'visual identity',
   'brand language', 'guidelines', 'brand world'],

  ['packaging', 'package', 'box', 'bottle', 'label', 'wrapper', 'container',
   'unboxing', 'dieline', 'structure'],

  ['poster', 'print', 'publication', 'book', 'zine', 'magazine', 'newspaper',
   'broadsheet', 'catalogue', 'annual report', 'printed matter'],

  ['wayfinding', 'signage', 'environmental', 'spatial', 'exhibition',
   'installation', 'experience design'],

  ['motion', 'animation', 'kinetic', 'moving image', 'video', 'film',
   'title sequence', 'broadcast', 'gif'],

  // ── PHOTOGRAPHY GENRES ──────────────────────────────────────────────────────
  ['documentary', 'photojournalism', 'reportage', 'news', 'witness',
   'human interest', 'social documentary', 'magnum'],

  ['commercial', 'advertising photography', 'product photography',
   'food photography', 'automotive', 'luxury goods'],

  ['fine art photography', 'conceptual photography', 'art photography',
   'gallery', 'limited edition', 'signed print'],

  // ── COMPOSITION ─────────────────────────────────────────────────────────────
  ['symmetry', 'symmetric', 'balanced', 'centred', 'formal', 'classical',
   'mirror', 'bilateral'],

  ['asymmetry', 'asymmetric', 'off-balance', 'dynamic', 'tension',
   'rule of thirds', 'golden ratio'],

  ['layers', 'depth', 'foreground', 'background', 'midground',
   'overlap', 'transparency', 'dimension'],

  ['flat', '2d', 'frontal', 'head-on', 'orthographic', 'map',
   'diagram', 'blueprint', 'technical'],

  // ── MOOD / FEELING ──────────────────────────────────────────────────────────
  ['calm', 'peaceful', 'serene', 'tranquil', 'meditative', 'contemplative',
   'still', 'hushed', 'undisturbed', 'placid'],

  ['tense', 'anxious', 'uneasy', 'disquieting', 'unsettling', 'eerie',
   'uncanny', 'psychological', 'paranoia', 'isolation'],

  ['intimate', 'close', 'personal', 'private', 'domestic', 'home',
   'everyday', 'vernacular', 'family', 'memory'],

  ['vast', 'monumental', 'epic', 'heroic', 'sublime', 'awe', 'scale',
   'grandeur', 'cathedral', 'infinity'],

  ['melancholy', 'sad', 'longing', 'nostalgia', 'lonesome', 'bittersweet',
   'elegiac', 'lament', 'solitude', 'isolation', 'absence'],

  ['joyful', 'celebratory', 'festive', 'euphoric', 'exuberant', 'happy',
   'pleasure', 'delight', 'abundance'],

  // ── MEDIUM / TECHNIQUE ──────────────────────────────────────────────────────
  ['oil painting', 'oil', 'canvas', 'acrylic', 'gouache', 'tempera',
   'fresco', 'encaustic', 'old master', 'impasto'],

  ['drawing', 'sketch', 'illustration', 'line art', 'pen and ink',
   'pencil', 'charcoal', 'pastel', 'graphite', 'crosshatch'],

  ['collage', 'cut and paste', 'photomontage', 'assemblage', 'found image',
   'archival material', 'clipping', 'layered'],

  ['printmaking', 'etching', 'lithograph', 'screenprint', 'woodcut',
   'linocut', 'risograph', 'letterpress', 'offset'],

  ['digital', '3d', 'render', 'cgi', 'generative', 'ai generated',
   'procedural', 'code', 'algorithm', 'data visualisation'],

  // ── SCALE / FORMAT ──────────────────────────────────────────────────────────
  ['macro', 'close-up', 'detail', 'extreme close-up', 'microscopic',
   'zoomed in', 'intimate scale'],

  ['wide', 'panoramic', 'full bleed', 'expansive', 'zoomed out',
   'establishing', 'overview', 'aerial'],

  ['square format', 'square', 'instagram', 'medium format aesthetic'],

  ['portrait format', 'vertical', 'tall', 'phone', 'story format'],

  ['landscape format', 'horizontal', 'wide', 'cinematic ratio', '16:9', '2.39:1'],

];

// ─────────────────────────────────────────────────────────────────────────────
// Build flat lookup: stemmed term → Set of related stemmed terms (and cluster index)
// ─────────────────────────────────────────────────────────────────────────────

const TERM_TO_CLUSTER_IDX = new Map();   // stemmed term → cluster index
const CLUSTER_TERMS        = [];          // cluster index → [stemmed terms]

for (let i = 0; i < CONCEPT_CLUSTERS.length; i++) {
  const stemmedCluster = CONCEPT_CLUSTERS[i].map(stem);
  CLUSTER_TERMS.push(stemmedCluster);
  for (const t of stemmedCluster) {
    if (!TERM_TO_CLUSTER_IDX.has(t)) TERM_TO_CLUSTER_IDX.set(t, []);
    TERM_TO_CLUSTER_IDX.get(t).push(i);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokeniser
// ─────────────────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with','by',
  'from','as','is','was','are','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','that','this',
  'it','its','i','me','my','we','our','you','your','feel','feeling','like',
  'kind','sort','type','something','very','really','quite','show','give','find',
  'look','looking','more','about','want','something','anything','everything',
  'get','some','any','all','just','also','much','many','most','more',
]);

function tokenise(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, ' ')
    .split(/\s+/)
    .map(t => t.replace(/^-+|-+$/g, ''))
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

// ─────────────────────────────────────────────────────────────────────────────
// Query expansion
// Returns { stemmedTokens, expandedTerms, clusterIndices }
// ─────────────────────────────────────────────────────────────────────────────

function expandQuery(rawTokens) {
  const stemmedTokens  = rawTokens.map(stem);
  const expandedTerms  = new Set(stemmedTokens);
  const clusterIndices = new Set();

  for (const t of stemmedTokens) {
    // Direct cluster membership
    const directClusters = TERM_TO_CLUSTER_IDX.get(t) ?? [];
    for (const ci of directClusters) {
      clusterIndices.add(ci);
      for (const ct of CLUSTER_TERMS[ci]) expandedTerms.add(ct);
    }

    // Fuzzy: find cluster terms close to this query token
    for (const [clusterTerm, indices] of TERM_TO_CLUSTER_IDX) {
      if (expandedTerms.has(clusterTerm)) continue;
      const s = fuzzyMatchScore(t, clusterTerm);
      if (s > 0) {
        for (const ci of indices) {
          clusterIndices.add(ci);
          for (const ct of CLUSTER_TERMS[ci]) expandedTerms.add(ct);
        }
      }
    }
  }

  return { stemmedTokens, expandedTerms: [...expandedTerms], clusterIndices };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────

// Field weights: title > board/channel > description > tags > misc
const FIELD_WEIGHTS = {
  title:   5,
  primary: 4,   // board name / channel
  desc:    3,
  tags:    2,
  misc:    1,
};

function buildPinCorpus(pin) {
  return [
    { text: pin.title,                            w: FIELD_WEIGHTS.title   },
    { text: pin.board_name,                       w: FIELD_WEIGHTS.primary },
    { text: pin.description,                      w: FIELD_WEIGHTS.desc    },
    { text: pin.note,                             w: FIELD_WEIGHTS.desc    },
    { text: pin.alt_text,                         w: FIELD_WEIGHTS.tags    },
    { text: pin.rich_metadata?.site_name,         w: FIELD_WEIGHTS.misc    },
    { text: pin.rich_metadata?.display_name,      w: FIELD_WEIGHTS.misc    },
    { text: pin.dominant_color,                   w: FIELD_WEIGHTS.misc    },
  ].filter(f => f.text).map(f => ({ ...f, lower: f.text.toLowerCase() }));
}

function buildVideoCorpus(video) {
  return [
    { text: video.title,                                  w: FIELD_WEIGHTS.title   },
    { text: video.channel_title,                          w: FIELD_WEIGHTS.primary },
    { text: video.description,                            w: FIELD_WEIGHTS.desc    },
    { text: (video.tags ?? []).join(' '),                 w: FIELD_WEIGHTS.tags    },
    { text: (video.topic_categories ?? []).join(' '),     w: FIELD_WEIGHTS.misc    },
  ].filter(f => f.text).map(f => ({ ...f, lower: f.text.toLowerCase() }));
}

const WORD_BOUNDARY = /\b/;

function tokeniseField(text) {
  return tokenise(text).map(stem);
}

function scoreItem(corpus, stemmedTokens, expandedTerms, rawQuery, clusterIndices) {
  const fullText = corpus.map(f => f.lower).join(' ');
  let score = 0;

  // ── Exact phrase match ──
  if (rawQuery.length > 3 && fullText.includes(rawQuery.toLowerCase())) score += 30;

  // ── All stemmed query tokens present somewhere ──
  if (stemmedTokens.every(t => fullText.includes(t))) score += 12;

  // ── Per-field scoring ──
  for (const { lower, w } of corpus) {
    const fieldTokens = tokeniseField(lower); // pre-stemmed field tokens

    for (const qt of stemmedTokens) {
      // Exact stemmed hit
      if (fieldTokens.includes(qt)) {
        score += w * 2.5;
      } else if (lower.includes(qt)) {
        // Substring (e.g. partial word, hyphenated)
        score += w * 1.5;
      } else {
        // Fuzzy
        const best = fieldTokens.reduce((m, ft) => Math.max(m, fuzzyMatchScore(qt, ft)), 0);
        if (best > 0) score += w * best * 0.8;
      }
    }

    // ── Expansion / synonym hits (lower weight) ──
    for (const et of expandedTerms) {
      if (stemmedTokens.includes(et)) continue; // already scored above
      if (fieldTokens.includes(et) || lower.includes(et)) score += w * 0.5;
    }
  }

  // ── Multi-cluster bonus ──
  // Count how many distinct activated clusters have evidence in this item
  let clustersHit = 0;
  for (const ci of clusterIndices) {
    const clusterHit = CLUSTER_TERMS[ci].some(ct =>
      corpus.some(f => f.lower.includes(ct))
    );
    if (clusterHit) clustersHit++;
  }
  if (clustersHit > 1) score += clustersHit * 4;

  return score;
}

// ─────────────────────────────────────────────────────────────────────────────
// Data loading
// ─────────────────────────────────────────────────────────────────────────────

function loadJSON(file) {
  const path = join(DATA_DIR, file);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function loadData() {
  const pinsData   = loadJSON('pins.json');
  const videosData = loadJSON('videos.json');
  return {
    pins:       pinsData?.pins    ?? [],
    boards:     pinsData?.boards  ?? [],
    pinsUser:   pinsData?.username  ?? null,
    pinsSync:   pinsData?.synced_at ?? null,
    videos:     videosData?.videos  ?? [],
    videosSync: videosData?.synced_at ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public search function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Search pins and videos with a natural language query.
 *
 * @param {string} query
 * @param {object} options
 * @param {number} [options.limit=20]       - max results
 * @param {string} [options.type='both']    - 'pins' | 'videos' | 'both'
 * @param {number} [options.minScore=1]     - drop items below this score
 * @returns {{ results, queryTokens, expandedCount, totalSearched }}
 */
export function searchReferences(query, { limit = 20, type = 'both', minScore = 1 } = {}) {
  const data = loadData();

  const rawTokens = tokenise(query);
  if (rawTokens.length === 0) {
    return { results: [], queryTokens: [], expandedCount: 0,
             totalSearched: { pins: data.pins.length, videos: data.videos.length } };
  }

  const { stemmedTokens, expandedTerms, clusterIndices } = expandQuery(rawTokens);

  const scored = [];

  if (type !== 'videos') {
    for (const pin of data.pins) {
      const corpus = buildPinCorpus(pin);
      const s = scoreItem(corpus, stemmedTokens, expandedTerms, query, clusterIndices);
      if (s >= minScore) scored.push({ type: 'pin', score: s, item: formatPin(pin) });
    }
  }

  if (type !== 'pins') {
    for (const video of data.videos) {
      const corpus = buildVideoCorpus(video);
      const s = scoreItem(corpus, stemmedTokens, expandedTerms, query, clusterIndices);
      if (s >= minScore) scored.push({ type: 'video', score: s, item: formatVideo(video) });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return {
    results:       scored.slice(0, limit),
    queryTokens:   rawTokens,
    expandedCount: expandedTerms.length - stemmedTokens.length,
    totalSearched: {
      pins:   type !== 'videos' ? data.pins.length   : 0,
      videos: type !== 'pins'   ? data.videos.length : 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Output formatters
// ─────────────────────────────────────────────────────────────────────────────

function truncate(str, len) {
  if (!str || str.length <= len) return str ?? null;
  return str.slice(0, len) + '…';
}

function formatPin(pin) {
  return {
    id:             pin.id,
    type:           'pin',
    title:          pin.title,
    description:    truncate(pin.description, 280),
    note:           truncate(pin.note, 140),
    board:          pin.board_name,
    link:           pin.link,
    image_url:      pin.image_url,
    dominant_color: pin.dominant_color,
    alt_text:       pin.alt_text,
    created_at:     pin.created_at,
    site:           pin.rich_metadata?.site_name ?? null,
  };
}

function formatVideo(video) {
  return {
    id:          video.id,
    type:        'video',
    title:       video.title,
    channel:     video.channel_title,
    channel_url: video.channel_url,
    url:         video.url,
    thumbnail:   video.thumbnail,
    duration:    video.duration,
    view_count:  video.view_count_text,
    published:   video.published_text,
    tags:        video.tags?.slice(0, 10) ?? [],
    topics:      video.topic_categories?.slice(0, 5) ?? [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Accessors used by other tools
// ─────────────────────────────────────────────────────────────────────────────

export function getAllPins()    { return loadData().pins.map(formatPin); }
export function getAllVideos()  { return loadData().videos.map(formatVideo); }
export function getDataSummary() {
  const d = loadData();
  return {
    pins:   { total: d.pins.length,   boards: d.boards.length, synced_at: d.pinsSync },
    videos: { total: d.videos.length, synced_at: d.videosSync },
  };
}
