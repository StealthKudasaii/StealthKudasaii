// Petites améliorations d'ergonomie (aucune dépendance, compatible CSP « script-src 'self' »).
document.addEventListener('submit', (e) => {
  const form = e.target;
  const submitter = e.submitter;
  const msg = (submitter && submitter.dataset.confirm) || form.dataset.confirm;
  if (msg && !window.confirm(msg)) e.preventDefault();
});

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-toggle-menu]');
  if (t) document.querySelector('.sidebar').classList.toggle('open');
});

// Affiche les champs pertinents selon le type de question choisi.
function syncQuestionFields(select) {
  const form = select.closest('form');
  const type = select.value;
  form.querySelectorAll('[data-for]').forEach((el) => {
    el.style.display = el.dataset.for.split(' ').includes(type) ? '' : 'none';
  });
}
document.querySelectorAll('select[data-question-type]').forEach((s) => {
  syncQuestionFields(s);
  s.addEventListener('change', () => syncQuestionFields(s));
});

// Champs spécifiques aux patch notes.
function syncKind(select) {
  const form = select.closest('form');
  form.querySelectorAll('[data-kind]').forEach((el) => {
    el.style.display = el.dataset.kind.split(' ').includes(select.value) ? '' : 'none';
  });
}
document.querySelectorAll('select[data-publication-kind]').forEach((s) => {
  syncKind(s);
  s.addEventListener('change', () => syncKind(s));
});
