// Applies the stored or OS theme before first paint (classic script, loaded in <head>).
(function () {
  var t = 'dark';
  try {
    var s = localStorage.getItem('sr:theme');
    if (s === 'dark' || s === 'light') t = s;
    else if (matchMedia('(prefers-color-scheme: light)').matches) t = 'light';
  } catch (e) { t = 'dark'; }
  document.documentElement.dataset.theme = t;
  var m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', t === 'light' ? '#F4F6FA' : '#0B0F17');
})();
