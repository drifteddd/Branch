# Privacy notice

version 2 · last updated: october 29, 2026

Branch is run by Drifted (contact: drifted1000@outlook.com). this page explains what Branch actually collects. the short version: no accounts, no ads, no tracking.

## what stays on your computer

- **favorites, recently viewed mods, settings** (like dark mode) and **that you accepted the terms** are saved inside the app on your computer. they never get sent to the server.
- you can clear favorites and history in Settings. uninstalling Branch removes all of it.
- downloaded files go wherever you choose to save them. Branch doesn't keep a list of them after you close the app.

## what the server sees

when you use Branch, your computer connects to the Branch server to load the mod list, pictures and downloads. like any website, the server can see your IP address while it handles the request.

- **rate limits:** to stop spam and abuse, the server keeps short-term counters using a one-way scrambled (hashed) version of your IP address, not the address itself. these live in memory and are gone when the server restarts.
- **download counts:** when you download a mod or open its download page through Branch, the server saves the hashed IP, the release and the date, so each person only counts once per day. these records are deleted after 30 days. only the total number is kept.
- **server logs:** the server logs things like which address was requested, the result and how long it took, so problems can be fixed. it doesn't log passwords, report text, request text or contact info. the hosting provider (Railway) may keep its own network logs under its own policies.
- **source code viewer:** when you view a mod's source code, the app loads it straight from GitHub, so GitHub sees that request under its own privacy policy.

Branch doesn't use analytics, advertising trackers or cookies in the app.

## the mod checker

when you check a mod:

- the file is sent to the Branch server, read in memory, and thrown away. it is never saved.
- the server pulls text clues out of the file (like function names, links and the names of files inside a zip). those clues, not the file, are sent to **SiliconFlow**, an AI service, so its model can judge them. SiliconFlow handles that data under its own privacy policy. don't check files that contain personal information.
- the result (score, summary and reasons) is saved together with the file's fingerprint (a sha-256 hash) for 30 days, so the same file doesn't need to be checked twice. the saved result doesn't say who checked it.
- to enforce the daily limit, the server keeps a count per hashed IP address. counts are deleted after 7 days.

## reports

if you report a mod, the server stores which mod, the reason, the details you wrote, your contact info if you chose to add it, a hashed IP address (for spam limits) and the time. reports are private, only the Branch admin can see them, and they're deleted 180 days after they're closed.

## mod requests

if you request a mod, the server stores the mod name, the link, the author and details you typed, your contact info if you chose to add it, a hashed IP address (for spam limits) and the time. requests are private to the admin and deleted 180 days after they're accepted or denied.

## children

Branch is for people 13 and older. Branch doesn't knowingly collect personal information from children under 13. if you're under 13, don't put contact info in a report or request. if you think a child sent us personal information, email drifted1000@outlook.com and it will be deleted.

## your choices and requests

you can ask to see or delete a report or request you sent, or ask any privacy question, by emailing drifted1000@outlook.com. say which mod it was about and roughly when, so it can be found. Branch doesn't sell or share personal information for advertising.

## other websites

some mods link to the author's own page (like GitHub). when you open those, you're on their website and their privacy policy applies.

## changes

if this notice changes in an important way, Branch will show it to you again in the app.
