// Runs synchronously at the top of <body>, before first paint, so the popup
// opens in the saved theme instead of flashing the default one.
(function () {
  try {
    var theme = localStorage.getItem("arTheme");
    if (theme === "dark" || theme === "blue") {
      document.body.classList.remove("theme-default");
      document.body.classList.add("theme-" + theme);
    }
  } catch (e) {
    // localStorage unavailable – keep the default theme.
  }
})();
