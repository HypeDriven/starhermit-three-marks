// Localized strings for the Graphics settings panel. The locale follows the
// game language (js/i18n.js passes it in); unknown languages fall
// back to en-US. `{x}` placeholders are filled by gfxT().

const STR = {
  'en-US': {
    quality: 'Quality', auto: 'Auto (detected: {tier})', fromPreset: 'From preset ({tier})',
    renderScale: 'Render scale', adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
    postFailed: 'Post-processing is unavailable on this device, so effects that need it are off.',
    presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
    cats: { shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade', antialias: 'Anti-aliasing', reflections: 'Reflections', particles: 'Particles', detail: 'Surface detail' },
    tiers: { off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Plain', detailed: 'Detailed' },
    words: { noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoFull: 'full ambient occlusion', bloom: 'bloom', reflections: 'reflections', noAA: 'no anti-aliasing', px: '{w}×{h} px', unknownGpu: 'unknown GPU', level: 'Level {n}' },
  },
  'en-GB': {
    quality: 'Quality', auto: 'Auto (detected: {tier})', fromPreset: 'From preset ({tier})',
    renderScale: 'Render scale', adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
    postFailed: 'Post-processing is unavailable on this device, so effects that need it are off.',
    presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
    cats: { shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Colour grade', antialias: 'Anti-aliasing', reflections: 'Reflections', particles: 'Particles', detail: 'Surface detail' },
    tiers: { off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Plain', detailed: 'Detailed' },
    words: { noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoFull: 'full ambient occlusion', bloom: 'bloom', reflections: 'reflections', noAA: 'no anti-aliasing', px: '{w}×{h} px', unknownGpu: 'unknown GPU', level: 'Level {n}' },
  },
  'es-419': {
    quality: 'Calidad', auto: 'Automática (detectada: {tier})', fromPreset: 'Según el ajuste ({tier})',
    renderScale: 'Escala de renderizado', adaptive: 'Resolución adaptable', showFps: 'Mostrar cuadros por segundo',
    postFailed: 'El posprocesamiento no está disponible en este dispositivo, así que los efectos que lo requieren están desactivados.',
    presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    cats: { shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color', antialias: 'Antialiasing', reflections: 'Reflejos', particles: 'Partículas', detail: 'Detalle de superficies' },
    tiers: { off: 'No', on: 'Sí', low: 'Bajas', medium: 'Medias', high: 'Altas', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Simple', detailed: 'Detallado' },
    words: { noShadows: 'sin sombras', shadows: 'sombras {n}²', ao: 'oclusión ambiental', aoFull: 'oclusión ambiental completa', bloom: 'resplandor', reflections: 'reflejos', noAA: 'sin antialiasing', px: '{w}×{h} px', unknownGpu: 'GPU desconocida', level: 'Nivel {n}' },
  },
  'es-ES': {
    quality: 'Calidad', auto: 'Automática (detectada: {tier})', fromPreset: 'Según el preajuste ({tier})',
    renderScale: 'Escala de renderizado', adaptive: 'Resolución adaptativa', showFps: 'Mostrar fotogramas por segundo',
    postFailed: 'El posprocesado no está disponible en este dispositivo, así que los efectos que lo necesitan están desactivados.',
    presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    cats: { shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Etalonaje de color', antialias: 'Antialiasing', reflections: 'Reflejos', particles: 'Partículas', detail: 'Detalle de superficies' },
    tiers: { off: 'No', on: 'Sí', low: 'Bajas', medium: 'Medias', high: 'Altas', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Sencillo', detailed: 'Detallado' },
    words: { noShadows: 'sin sombras', shadows: 'sombras {n}²', ao: 'oclusión ambiental', aoFull: 'oclusión ambiental completa', bloom: 'resplandor', reflections: 'reflejos', noAA: 'sin antialiasing', px: '{w}×{h} px', unknownGpu: 'GPU desconocida', level: 'Nivel {n}' },
  },
  'de-DE': {
    quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})', fromPreset: 'Aus Voreinstellung ({tier})',
    renderScale: 'Renderskalierung', adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
    postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar, daher sind die davon abhängigen Effekte aus.',
    presets: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
    cats: { shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Bloom', grade: 'Farbkorrektur', antialias: 'Kantenglättung', reflections: 'Reflexionen', particles: 'Partikel', detail: 'Oberflächendetails' },
    tiers: { off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Einfach', detailed: 'Detailliert' },
    words: { noShadows: 'keine Schatten', shadows: '{n}²-Schatten', ao: 'Umgebungsverdeckung', aoFull: 'volle Umgebungsverdeckung', bloom: 'Bloom', reflections: 'Reflexionen', noAA: 'keine Kantenglättung', px: '{w}×{h} px', unknownGpu: 'unbekannte GPU', level: 'Stufe {n}' },
  },
  'fr-FR': {
    quality: 'Qualité', auto: 'Auto (détectée : {tier})', fromPreset: 'Selon le préréglage ({tier})',
    renderScale: 'Échelle de rendu', adaptive: 'Résolution adaptative', showFps: 'Afficher les images par seconde',
    postFailed: 'Le post-traitement est indisponible sur cet appareil ; les effets qui en dépendent sont désactivés.',
    presets: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
    cats: { shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Flou lumineux', grade: 'Étalonnage des couleurs', antialias: 'Anticrénelage', reflections: 'Reflets', particles: 'Particules', detail: 'Détail des surfaces' },
    tiers: { off: 'Désactivé', on: 'Activé', low: 'Basses', medium: 'Moyennes', high: 'Hautes', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Simple', detailed: 'Détaillé' },
    words: { noShadows: 'sans ombres', shadows: 'ombres {n}²', ao: 'occlusion ambiante', aoFull: 'occlusion ambiante complète', bloom: 'flou lumineux', reflections: 'reflets', noAA: 'sans anticrénelage', px: '{w}×{h} px', unknownGpu: 'GPU inconnu', level: 'Niveau {n}' },
  },
  'fr-CA': {
    quality: 'Qualité', auto: 'Auto (détectée : {tier})', fromPreset: 'Selon le préréglage ({tier})',
    renderScale: 'Échelle de rendu', adaptive: 'Résolution adaptative', showFps: 'Afficher la fréquence d’images',
    postFailed: 'Le post-traitement n’est pas offert sur cet appareil; les effets qui en dépendent sont désactivés.',
    presets: { low: 'Basse', balanced: 'Équilibrée', high: 'Élevée', ultra: 'Ultra' },
    cats: { shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Correction des couleurs', antialias: 'Anticrénelage', reflections: 'Reflets', particles: 'Particules', detail: 'Détail des surfaces' },
    tiers: { off: 'Désactivé', on: 'Activé', low: 'Basses', medium: 'Moyennes', high: 'Élevées', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Simple', detailed: 'Détaillé' },
    words: { noShadows: 'sans ombres', shadows: 'ombres {n}²', ao: 'occlusion ambiante', aoFull: 'occlusion ambiante complète', bloom: 'halo lumineux', reflections: 'reflets', noAA: 'sans anticrénelage', px: '{w}×{h} px', unknownGpu: 'GPU inconnu', level: 'Niveau {n}' },
  },
  'pt-BR': {
    quality: 'Qualidade', auto: 'Automática (detectada: {tier})', fromPreset: 'Da predefinição ({tier})',
    renderScale: 'Escala de renderização', adaptive: 'Resolução adaptável', showFps: 'Mostrar taxa de quadros',
    postFailed: 'O pós-processamento não está disponível neste dispositivo, então os efeitos que dependem dele estão desligados.',
    presets: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    cats: { shadows: 'Sombras', ao: 'Oclusão de ambiente', bloom: 'Brilho', grade: 'Correção de cor', antialias: 'Suavização de serrilhado', reflections: 'Reflexos', particles: 'Partículas', detail: 'Detalhe das superfícies' },
    tiers: { off: 'Desligado', on: 'Ligado', low: 'Baixas', medium: 'Médias', high: 'Altas', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Simples', detailed: 'Detalhado' },
    words: { noShadows: 'sem sombras', shadows: 'sombras {n}²', ao: 'oclusão de ambiente', aoFull: 'oclusão de ambiente completa', bloom: 'brilho', reflections: 'reflexos', noAA: 'sem suavização', px: '{w}×{h} px', unknownGpu: 'GPU desconhecida', level: 'Nível {n}' },
  },
  'it-IT': {
    quality: 'Qualità', auto: 'Automatica (rilevata: {tier})', fromPreset: 'Dal preset ({tier})',
    renderScale: 'Scala di rendering', adaptive: 'Risoluzione adattiva', showFps: 'Mostra frame rate',
    postFailed: 'La post-elaborazione non è disponibile su questo dispositivo, quindi gli effetti che la richiedono sono disattivati.',
    presets: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
    cats: { shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore', antialias: 'Antialiasing', reflections: 'Riflessi', particles: 'Particelle', detail: 'Dettaglio superfici' },
    tiers: { off: 'Disattivato', on: 'Attivato', low: 'Basse', medium: 'Medie', high: 'Alte', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', plain: 'Semplice', detailed: 'Dettagliato' },
    words: { noShadows: 'senza ombre', shadows: 'ombre {n}²', ao: 'occlusione ambientale', aoFull: 'occlusione ambientale completa', bloom: 'bagliore', reflections: 'riflessi', noAA: 'senza antialiasing', px: '{w}×{h} px', unknownGpu: 'GPU sconosciuta', level: 'Livello {n}' },
  },
};

export const GFX_LOCALES = Object.keys(STR);

const FALLBACK = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };

/** Best supported locale for a BCP-47 tag (e.g. navigator.language). */
export function pickLocale(tag) {
  const t = String(tag || '').replace('_', '-');
  const exact = GFX_LOCALES.find((l) => l.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const lang = t.split('-')[0].toLowerCase();
  if (lang === 'es' && /-ES$/i.test(t)) return 'es-ES';
  return FALLBACK[lang] || 'en-US';
}

/** Returns a translator bound to one locale: t('quality'), t('cats.bloom'), t('auto', { tier }). */
export function gfxStrings(locale) {
  const table = STR[pickLocale(locale)];
  return (key, vars = {}) => {
    const v = key.split('.').reduce((o, k) => (o ? o[k] : undefined), table) ?? key.split('.').reduce((o, k) => (o ? o[k] : undefined), STR['en-US']) ?? key;
    return String(v).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  };
}

/** Localized words for the cost summary line (gfx.describe). */
export function gfxWords(locale) { return STR[pickLocale(locale)].words; }
