// applies the saved theme before the page paints. kept tiny on purpose.
(function () {
  try {
    var saved = JSON.parse(localStorage.getItem("branch.settings") || "{}");
    // light is the default. "system" and "dark" switch the tokens in shared/tokens.css
    if (saved.theme === "system" || saved.theme === "dark") document.documentElement.dataset.theme = saved.theme;
    if (saved.reduceMotion) document.documentElement.dataset.motion = "reduce";
  } catch (e) {
    // storage can be unavailable. the defaults are fine.
  }
})();
