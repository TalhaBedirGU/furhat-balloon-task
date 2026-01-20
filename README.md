# Furhat & XState starter
To run:

First, open Furhat SDK desktop launcher. Then click on Remote API. On the webpage (default password is "admin"), select a Neural English voice. After that, clone the repository and in the repository, run:

```
yarn
```

```
ssh -f -N -p 62266 -L 11434:127.0.0.1:11434 <your_id>@mltgpu.flov.gu.se
```

```
npx tsx src/main.ts
```

Based on:

https://github.com/GU-CLASP/dialogue-systems-2-2025

https://github.com/vladmaraev/xstate-furhat-starter
