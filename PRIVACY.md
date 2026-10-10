# Privacy Policy – Auto Reloader

_Last updated: 10 October 2026_

Auto Reloader is a Chrome extension that reloads browser tabs automatically on a timer or
according to URL rules you define. This policy explains what it does with your data.

## Summary

**Auto Reloader does not collect, transmit, sell or share any personal data.** Everything it
stores stays on your device.

## What the extension accesses

To do its job the extension reads, for tabs you set a timer on or that match one of your rules:

- the tab's **URL**, used to match your automation rules;
- the tab's **title and favicon**, used only to label the timer in the extension popup.

## What is stored

The extension saves the following in Chrome's local extension storage (`chrome.storage.local`)
on your device:

- your active and paused timers (tab, interval, next reload time);
- your automation rules (pattern, match type, interval, optional URL);
- your settings (theme, cache-bypass and "don't reload the tab I'm viewing" options).

This data is never sent to the developer or to any third party. It is removed when you stop a
timer, delete a rule, or uninstall the extension.

## What the extension does not do

- It does not send any data over the network. It has no server, no analytics, no advertising
  and no tracking.
- It does not read or modify the content of web pages. It has no host permissions and no content
  scripts.
- It does not load or run remotely hosted code.
- It does not sell data or use it for purposes unrelated to the extension's single purpose of
  reloading tabs.

## Permissions

| Permission | Why it is needed                                                                       |
| ---------- | -------------------------------------------------------------------------------------- |
| `tabs`     | Read tab URL, title and favicon to match rules and to show timers in the popup.        |
| `storage`  | Save your timers, rules and settings on your device.                                   |
| `alarms`   | Schedule the automatic reloads, including while the extension is in the background.    |

## Changes to this policy

If this policy changes, the updated version will be published at this address and the date above
will be updated.

## Contact

Questions about this policy: **[your contact email]**
