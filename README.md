<p align="center">
  <img src="app/ui/shared/branch-mark.svg" width="96" height="96" alt="Branch icon">
</p>

<h1 align="center">Branch</h1>

<p align="center">a free, community-run windows app for finding and sharing gorilla tag mods. made by Drifted.</p>

---

open it, search or scroll, click a mod, press download. made a mod? upload it in a minute. no account, no ads, no tracking.

> Branch is an independent project. it isn't made by, endorsed by, or connected to Another Axiom or the Gorilla Tag team.

## what you can do

- **browse and search** mods by name, description, author or tag
- **filter** by category and compatibility, and **sort** by recently updated, newest, name or downloads
- **read about a mod** before you get it: screenshots, install steps, changelog, requirements, license and the file's checksum
- **view a mod's source code** right in the app, when the author has it on github
- **download** with a progress bar, a cancel button and "show in folder". Branch only saves the file. it never runs or installs anything and never asks for admin access
- **check a mod for viruses** with the free AI mod checker (20 checks a day). it looks for stealers, RATs and other malware, not cheats
- **upload your own mod**: all you need is the file, a name and a description. you can stay anonymous. up to 10 uploads a day, and every upload goes through an automatic safety check
- **save favorites** and see what you looked at recently. this stays on your computer
- **report** a broken, outdated, misleading or harmful mod, or a copyright problem
- **light or dark mode**, keyboard shortcuts (ctrl+f to search, alt+left to go back) and reduced motion

## download

go to the [actions tab](../../actions/workflows/windows-build.yml), open the newest successful **windows build**, and download **branch-windows-installer** at the bottom. unzip it and run the setup file.

the installer isn't code-signed yet, so windows might say "windows protected your pc". click **more info**, then **run anyway**. it installs just for you and doesn't need admin rights.

## staying safe with mods

- mods are made by other people, including other users. Branch doesn't make them and can't promise any of them are safe.
- community uploads are marked "Community" and are only checked automatically.
- back up your game folder before installing anything.
- the mod checker is a helpful extra, not a guarantee. a low score doesn't prove a file is safe.
- using mods in public lobbies can break the game's rules and get you banned. that's on whoever uses the mod.

## privacy

no accounts, no ads, no analytics. favorites, history and settings stay on your computer. read the full [privacy notice](app/ui/legal/privacy.md) and [terms of use](app/ui/legal/terms.md). you'll be asked to accept the terms the first time you open Branch.

## copyright and takedowns

if you made a mod and want it changed or removed from Branch, use the report button in the app, or see the [takedown page](app/ui/legal/takedown.md).

## for developers

Branch is built with [tauri](https://tauri.app) and rust. the interface is plain html, css and javascript in `app/ui`, and the desktop shell is in `app/src-tauri`. to try the interface in a browser with fake demo data:

```
node dev/mock-server.mjs
```

then open http://localhost:5173. the click-through tests run with `node dev/e2e.mjs`.

pull requests are welcome. every pull request runs the checks automatically.

## contact

drifted1000@outlook.com

## license

Branch's own code is [MIT licensed](LICENSE). that doesn't cover the mods listed in it, and it doesn't cover anything from gorilla tag. see [licenses and credits](app/ui/legal/licenses.md).
