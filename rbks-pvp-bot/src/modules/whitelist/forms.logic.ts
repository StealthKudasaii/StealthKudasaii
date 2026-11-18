import type { QuestionType } from '../../config/constants';
import { chunk } from '../../core/text';
import { choicesOf, type AnswerSnapshot, type Form, type Question, type QuestionInput } from './forms.repo';

/** Discord : 5 composants maximum par fenêtre modale → les formulaires longs sont découpés en étapes. */
export const QUESTIONS_PER_PAGE = 5;
export const MAX_QUESTIONS = 25;
export const MAX_CHOICES = 25;

export const LIMITS = {
  label: 45,
  description: 100,
  placeholder: 100,
  choice: 100,
  short: 200,
  long: 1500,
  number: 20,
  roblox: 20,
} as const;

export function pages(qs: Question[]): Question[][] {
  return chunk(qs, QUESTIONS_PER_PAGE);
}

export type FormState = 'draft' | 'closed' | 'scheduled' | 'open' | 'ended' | 'full';

export function formState(f: Pick<Form, 'status' | 'opens_at' | 'closes_at' | 'max_applications'>, count: number, now = Date.now()): FormState {
  if (f.status === 'draft') return 'draft';
  if (f.status === 'closed') return 'closed';
  if (f.opens_at && f.opens_at > now) return 'scheduled';
  if (f.closes_at && f.closes_at <= now) return 'ended';
  if (f.max_applications && count >= f.max_applications) return 'full';
  return 'open';
}

export const FORM_STATE_LABEL: Record<FormState, string> = {
  draft: '📝 Brouillon',
  closed: '🔒 Fermé',
  scheduled: '⏳ Bientôt ouvert',
  open: '🟢 Ouvert',
  ended: '⌛ Terminé',
  full: '🈵 Complet',
};

export const ROBLOX_RE = /^[A-Za-z0-9_]{3,20}$/;

/**
 * Valide les réponses d'une étape. Les valeurs brutes viennent de la modale.
 * Retourne les erreurs lisibles (vides si tout est valide).
 */
export function validateAnswers(qs: Question[], raw: Record<string, string | string[]>): string[] {
  const errors: string[] = [];
  for (const q of qs) {
    const v = raw[String(q.id)];
    const empty = v === undefined || (Array.isArray(v) ? v.length === 0 : v.trim() === '');
    if (empty) {
      if (q.required) errors.push(`« ${q.label} » est obligatoire.`);
      continue;
    }
    switch (q.type) {
      case 'number': {
        const n = Number(String(v).replace(',', '.').trim());
        if (!Number.isFinite(n)) errors.push(`« ${q.label} » doit être un nombre.`);
        else if (q.min_value !== null && n < q.min_value) errors.push(`« ${q.label} » doit être supérieur ou égal à ${q.min_value}.`);
        else if (q.max_value !== null && n > q.max_value) errors.push(`« ${q.label} » doit être inférieur ou égal à ${q.max_value}.`);
        break;
      }
      case 'roblox':
        if (!ROBLOX_RE.test(String(v).trim())) errors.push(`« ${q.label} » : pseudo Roblox invalide (3 à 20 caractères, lettres, chiffres ou _).`);
        break;
      case 'single':
      case 'multi': {
        const list = Array.isArray(v) ? v : [v];
        const choices = choicesOf(q);
        if (q.type === 'single' && list.length > 1) errors.push(`« ${q.label} » n’accepte qu’un seul choix.`);
        if (list.some((x) => !/^\d+$/.test(x) || Number(x) >= choices.length)) errors.push(`« ${q.label} » : choix invalide.`);
        break;
      }
      case 'short':
        if (String(v).length > LIMITS.short) errors.push(`« ${q.label} » est trop long.`);
        break;
      case 'long':
        if (String(v).length > LIMITS.long) errors.push(`« ${q.label} » est trop long.`);
        break;
    }
  }
  return errors;
}

/** Fige les réponses (avec l'intitulé de la question) pour que l'historique reste lisible même si le formulaire change. */
export function snapshotAnswers(qs: Question[], raw: Record<string, string | string[]>): AnswerSnapshot[] {
  return qs.map((q) => {
    const v = raw[String(q.id)];
    let value: string | string[] = '';
    if (q.type === 'single' || q.type === 'multi') {
      const choices = choicesOf(q);
      const list = (Array.isArray(v) ? v : v ? [v] : []).map((x) => choices[Number(x)]).filter(Boolean);
      value = q.type === 'single' ? (list[0] ?? '') : list;
    } else {
      value = typeof v === 'string' ? v.trim() : '';
    }
    return { qid: q.id, label: q.label, type: q.type, value };
  });
}

export function answerText(a: AnswerSnapshot): string {
  if (Array.isArray(a.value)) return a.value.length ? a.value.map((x) => `• ${x}`).join('\n') : '—';
  return a.value || '—';
}

/** Valide la définition d'une question saisie par le staff (modale ou panel). */
export function parseQuestionInput(input: {
  label: string;
  description?: string;
  type: string;
  required: boolean;
  choices?: string;
  placeholder?: string;
  range?: string;
}): { ok: true; value: QuestionInput } | { ok: false; error: string } {
  const type = input.type as QuestionType;
  if (!['short', 'long', 'single', 'multi', 'number', 'roblox'].includes(type)) return { ok: false, error: 'Type de question inconnu.' };
  const label = input.label.trim();
  if (!label) return { ok: false, error: 'L’intitulé est obligatoire.' };
  if (label.length > LIMITS.label) return { ok: false, error: `L’intitulé doit faire ${LIMITS.label} caractères maximum (limite Discord).` };
  const description = (input.description ?? '').trim();
  if (description.length > LIMITS.description) return { ok: false, error: `La description doit faire ${LIMITS.description} caractères maximum.` };
  const placeholder = (input.placeholder ?? '').trim();
  if (placeholder.length > LIMITS.placeholder) return { ok: false, error: `Le texte indicatif doit faire ${LIMITS.placeholder} caractères maximum.` };
  let choices: string[] = [];
  if (type === 'single' || type === 'multi') {
    choices = [...new Set((input.choices ?? '').split(/\r?\n/).map((c) => c.trim()).filter(Boolean))];
    if (choices.length < 2) return { ok: false, error: 'Indique au moins 2 choix (un par ligne).' };
    if (choices.length > MAX_CHOICES) return { ok: false, error: `${MAX_CHOICES} choix maximum (limite Discord).` };
    if (choices.some((c) => c.length > LIMITS.choice)) return { ok: false, error: `Chaque choix doit faire ${LIMITS.choice} caractères maximum.` };
  }
  let min_value: number | null = null;
  let max_value: number | null = null;
  if (type === 'number' && input.range?.trim()) {
    const m = input.range.trim().replace(/,/g, '.').match(/^(-?\d+(?:\.\d+)?)?\s*(?:-|à|\.\.)\s*(-?\d+(?:\.\d+)?)?$/);
    if (!m) return { ok: false, error: 'Plage invalide : utilise le format « min-max », par exemple 0-100.' };
    min_value = m[1] !== undefined ? Number(m[1]) : null;
    max_value = m[2] !== undefined ? Number(m[2]) : null;
    if (min_value !== null && max_value !== null && min_value > max_value) return { ok: false, error: 'Le minimum dépasse le maximum.' };
  }
  return { ok: true, value: { label, description: description || null, type, required: input.required, choices, placeholder: placeholder || null, min_value, max_value } };
}

/** Modèle prêt à l'emploi (modifiable entièrement ensuite). */
export const BETA_TEMPLATE: QuestionInput[] = [
  { label: 'Quel est ton pseudo Roblox ?', type: 'roblox', required: true, placeholder: 'Ton nom d’utilisateur Roblox exact' },
  { label: 'Quel est ton identifiant Discord ?', type: 'short', required: false, description: 'Ton compte Discord est déjà joint automatiquement à la candidature.', placeholder: 'ex. pseudo' },
  { label: 'Sur quelle plateforme joues-tu ?', type: 'single', required: true, choices: ['PC', 'Mobile', 'Tablette', 'Console'] },
  { label: 'Pourquoi souhaites-tu rejoindre la bêta ?', type: 'long', required: true, placeholder: 'Parle-nous de ta motivation' },
  { label: 'As-tu déjà participé à des bêta-tests ?', type: 'single', required: true, choices: ['Oui, plusieurs fois', 'Oui, une fois', 'Non, jamais'] },
  { label: 'Disponible pour les sessions de test ?', type: 'single', required: true, choices: ['Oui, régulièrement', 'De temps en temps', 'Rarement'] },
  { label: 'Temps consacré aux tests par semaine ?', type: 'single', required: true, choices: ['Moins d’1 heure', '1 à 3 heures', '3 à 6 heures', 'Plus de 6 heures'] },
];
