# AutoReloader

AutoReloader is a Chrome extension that automatically reloads browser
tabs at user-defined intervals.

It supports both **manual timers for individual tabs** and **automation
rules that automatically apply reload timers to matching URLs**.

## Current Version

**1.2.0**

AutoReloader uses **Manifest V3** and requires **Chrome 120 or later**.

## Features

### Manual tab timers

- Start an automatic reload timer for the current tab.
- Configure the reload interval in seconds.
- Pause and resume individual timers.
- Stop individual timers.
- Pause all active timers.
- Stop all timers.
- Run multiple timers simultaneously across different tabs.
- Display the current timer status in the Chrome toolbar badge.
- Show a countdown during the final seconds before a reload.

### Automation rules

Automation rules allow AutoReloader to automatically attach a reload
timer to tabs whose URLs match a configured pattern.

Supported matching methods:

- **Contains text** --- matches URLs containing the supplied text.
- **Wildcard** --- supports `*` and `?`.
- **Regular expression** --- matches URLs using a regular expression.

Rules can include:

- URL matching pattern
- Reload interval
- Active/paused status
- Optional URL to open a new tab
- Rule-specific automation

When a matching page is opened or navigated to, AutoReloader can
automatically apply the relevant rule.

### Reload options

- Configurable reload interval.
- Optional cache bypass when reloading.
- Optional setting to avoid reloading the currently focused tab.

Chrome's published-extension alarm behaviour imposes a **30-second
minimum interval**, so AutoReloader enforces a minimum interval of 30
seconds.

The maximum configured interval is 7 days.

### Themes

The popup currently supports:

- Default
- Dark
- Blue

The selected theme is retained between sessions.

### Developer Mode

A Developer Mode option provides additional diagnostic information in
the extension popup.

## Extension Architecture

AutoReloader is currently a deliberately lightweight Chrome extension
without a build framework.

```text
AutoReloader/
├── manifest.json
├── background.js
├── popup.html
├── popup.js
├── popup.css
├── theme-init.js
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── .gitignore
```

### `manifest.json`

Defines the Chrome extension metadata, Manifest V3 configuration, popup,
service worker, icons and required permissions.

### `background.js`

The background service worker contains the main application logic,
including:

- Timer management
- Chrome alarms
- Automatic reloads
- Automation rules
- URL matching
- Persistent state
- Toolbar badges
- Tab lifecycle handling
- Startup/reconciliation logic
- Message handling between the popup and service worker

The extension uses a serialized state-update queue so that concurrent
state changes are processed safely before being persisted.

### `popup.html`

Defines the extension's user interface.

The popup currently provides panels for:

- Current tab
- Active and paused timers
- Automation rules
- Options

### `popup.js`

Controls the popup interface and communicates with the background
service worker.

### `popup.css`

Contains the popup layout, controls, timer displays, themes and other
visual styling.

### `theme-init.js`

Applies the previously selected theme before the popup's first paint to
minimise visual flashing when opening the popup.

## Chrome Permissions

AutoReloader currently requests:

---

Permission Purpose

---

`tabs` Read tab information and manage
tabs involved in timers and
automation

`storage` Persist timers, automation rules
and user settings

`alarms` Schedule automatic reloads

---

No host permissions are currently declared in the manifest.

## Persistent Data

AutoReloader stores its application state using `chrome.storage.local`.

The main storage areas are:

- `timers` --- currently active or paused tab timers
- `autoRules` --- saved automation rules
- `settings` --- user preferences

Timers associated with closed tabs are removed automatically.

## Installing for Development

1.  Open Chrome.

2.  Navigate to:

    `chrome://extensions`

3.  Enable **Developer mode**.

4.  Select **Load unpacked**.

5.  Select the AutoReloader project directory.

6.  Open the AutoReloader popup from the Chrome toolbar.

7.  Test the required functionality.

After changing extension files, use **Reload** on the extension's card
in `chrome://extensions`.

## Development Workflow

AutoReloader is maintained using Git and GitHub.

The repository uses two primary branches:

- `main` --- known-good/releasable code
- `development` --- active development and experimentation

Recommended workflow:

```text
development
    ↓
make and test changes
    ↓
commit
    ↓
push to GitHub
    ↓
test
    ↓
merge to main
```

The `main` branch should remain a stable checkpoint.

## Git

Check the current status:

```bash
git status
```

Create and switch to the development branch:

```bash
git checkout -b development
```

Commit changes:

```bash
git add .
git commit -m "Describe the change"
```

Push changes:

```bash
git push
```

## Testing

Because AutoReloader is currently a plain JavaScript Chrome extension,
there is no build step required to load it during development.

After making changes:

1.  Save the files.
2.  Open `chrome://extensions`.
3.  Reload AutoReloader.
4.  Test the affected functionality.
5.  Check the service worker console if background errors occur.
6.  Check the popup's Developer Mode diagnostics where appropriate.
7.  Commit working changes to Git.

## Known Technical Constraints

### Chrome alarm interval

Chrome imposes a minimum alarm interval for published extensions.
AutoReloader therefore uses 30 seconds as its minimum supported reload
interval.

### Service worker lifecycle

The Manifest V3 background service worker can be stopped and restarted
by Chrome.

AutoReloader therefore persists important state in
`chrome.storage.local` and uses Chrome alarms for scheduled work rather
than relying solely on JavaScript timers.

The implementation also includes reconciliation and startup handling to
restore the appropriate timer/rule state.

### Short countdowns

The toolbar badge provides a short countdown immediately before a
scheduled reload.

Because Manifest V3 service workers are not continuously running,
AutoReloader uses a combination of Chrome alarms and short-lived
in-worker timers to support the countdown.

## Security and Privacy

AutoReloader currently does not require a remote server or external API.

Application state is stored locally using Chrome extension storage.

The extension's current manifest does not declare broad website host
permissions.

Before publishing future versions, permissions and data handling should
be reviewed against the Chrome Web Store's current policies.

## Future Development

Potential areas for future development include:

- Improved popup UX
- Better timer and automation-rule management
- More detailed diagnostics
- Import/export of settings and rules
- Presets for common reload intervals
- Improved accessibility
- More robust automated testing
- Modular JavaScript architecture
- TypeScript migration if justified
- Build and release tooling
- Chrome Web Store release automation
- Usage analytics only if genuinely required and appropriately
  disclosed
- Optional premium features and licensing, if the product is
  commercialised

Changes should be introduced incrementally so the existing working
extension remains stable.

## Development Principle

**Protect the working version first. Improve it incrementally.**

AutoReloader is already functional, so major architectural changes
should only be made when they provide a clear benefit.

Git branches and commits should be used as safety checkpoints throughout
development.
