(function () {
  try {
    var saved = JSON.parse(localStorage.getItem("branch.settings") || "{}");
    if (saved.theme === "system" || saved.theme === "dark") document.documentElement.dataset.theme = saved.theme;
    if (saved.reduceMotion) document.documentElement.dataset.motion = "reduce";
  } catch (e) {
  }
})();
