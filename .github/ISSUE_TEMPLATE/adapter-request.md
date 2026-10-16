---
name: Adapter request
about: A dependency we can't test yet
title: "Adapter: "
labels: ["adapter"]
---

> Don't paste keys, connection strings, personal email addresses or real customer data into this issue.

**The system**

What is the dependency? For example: a mail relay, a payment provider, a file drop, a message queue or a desktop app. Name the product and its version if you know them.

**How it's reached**

How does the system under test talk to it? For example: HTTP, a queue, files in a folder, a database, or a window on screen.

**What to observe**

What should the adapter report after each case? For example: the messages sent, the files written or the rows changed. What changes on every run, such as ids and times, and should be left out?

**Sandbox available?**

Is there a sandbox, test mode, emulator or capture server? Money and messages are only ever tested in a sandbox, so we can't build an adapter for them without one.

**Who owns it**

Which team or supplier owns the dependency? Give a team or role, not a person's contact details.
