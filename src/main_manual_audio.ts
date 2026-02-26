import { setup, createActor, fromPromise, assign } from "xstate";
import * as readline from 'readline';
// Imports for server and file system (required for audio importing)
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

// >>> HANDLING RECORDED AUDIO IMPORTS /BEGIN <<<
const AUDIO_PORT = 8000;
const AUDIO_DIR = path.join(__dirname, 'audio');
const firstMessageWaitTimeMs = 10000; // 10 seconds for the first message

http.createServer((req, res) => {
  const filePath = path.join(AUDIO_DIR, req.url || '');
  
  if (fs.existsSync(filePath) && filePath.endsWith('.wav')) {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('File not found');
  }
}).listen(AUDIO_PORT, () => {
  console.log(`Audio server running at http://localhost:${AUDIO_PORT}`);
});

const audioFiles: Record<string, string> = {
  '1': `http://localhost:${AUDIO_PORT}/hmm_doctor.wav`,
  '2': `http://localhost:${AUDIO_PORT}/hmm_pregnant.wav`,
  '3': `http://localhost:${AUDIO_PORT}/hmm_child.wav`,
  '4': `http://localhost:${AUDIO_PORT}/hmm_pilot.wav`,

  'q': `http://localhost:${AUDIO_PORT}/pause_doctor.wav`,
  'w': `http://localhost:${AUDIO_PORT}/pause_pregnant.wav`,
  'e': `http://localhost:${AUDIO_PORT}/pause_child.wav`,
  'r': `http://localhost:${AUDIO_PORT}/pause_pilot.wav`,

  'a': `http://localhost:${AUDIO_PORT}/hahaha_doctor.wav`,
  's': `http://localhost:${AUDIO_PORT}/hahaha_pregnant.wav`,
  'd': `http://localhost:${AUDIO_PORT}/hahaha_child.wav`,
  'f': `http://localhost:${AUDIO_PORT}/hahaha_pilot.wav`,
};
// >>> HANDLING RECORDED AUDIO IMPORTS /END <<<

// >>> TYPES /BEGIN <<<
type Message = { // LLM dialogue structure. The system will constantly change between these roles at each turn.
  role: "assistant" | "user" | "system"; // system is a sole actor. Assistant is the LLM. User is us.
  content: string;
};

interface DMContext { // Our regular DMContext types.
  lastResult: string;
  messages: Message[];
  isFirstMessage: boolean; // If the message is the first message.
  pendingManipulation: string | null; // Stores the manipulation phrase to add to next assistant turn
  keyPressed: string | null; // Stores which key was pressed
  userSpeechBuffer: string[]; // NEW: Accumulates user utterances before processing
}
// >>> TYPES /END <<<

const FURHATURI = "192.168.1.11:54321";
const OLLAMA_API_URL = "http://localhost:11434/api/chat";

// Setup readline interface for keyboard input in Node.js
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

// >>> Furhat Remote API functions /BEGIN <<<
async function fhVoice(name: string) { // fh functions are fetched from Furhat's URI. They are ready-made functions.
  const myHeaders = new Headers();
  myHeaders.append("accept", "application/json");
  const encName = encodeURIComponent(name);
  return fetch(`http://${FURHATURI}/furhat/voice?name=${encName}`, {
    method: "POST",
    headers: myHeaders,
    body: "",
  });
}

async function fhSay(text: string, isFirstMessage: boolean = false) { 
  const myHeaders = new Headers();
  myHeaders.append("accept", "application/json");
  const encText = encodeURIComponent(text);
  await fetch(`http://${FURHATURI}/furhat/say?text=${encText}&blocking=true`, {
    method: "POST",
    headers: myHeaders,
    body: "",
  });
  
  // 10 second delay for first message (long introduction), 1 second for others
  const delay = isFirstMessage ? firstMessageWaitTimeMs : 1000; // Bora's bandaid solution It let's you wait 15 secs after the first (explaining) turn of Furhat--Good old timeout on the first state.
  await new Promise(resolve => setTimeout(resolve, delay));
}

async function fhSayAudio(audioUrl: string, isFirstMessage: boolean = false) {
  const myHeaders = new Headers();
  myHeaders.append("accept", "application/json");
  const encUrl = encodeURIComponent(audioUrl);
  
  // Remove the 'text=' and use 'url=' instead
  await fetch(`http://${FURHATURI}/furhat/say?url=${encUrl}&blocking=true&lipsync=true`, {
    method: "POST",
    headers: myHeaders,
    body: "",
  });
  
  const delay = isFirstMessage ? firstMessageWaitTimeMs : 1000;
  await new Promise(resolve => setTimeout(resolve, delay));
}

const timer = fromPromise(
  ({ input }: { input: { ms: number } }) =>
    new Promise((resolve) => setTimeout(resolve, input.ms))
);

async function fhAttendUser() { // This is about GAZE.
  const myHeaders = new Headers();
  myHeaders.append("accept", "application/json");
  return fetch(`http://${FURHATURI}/furhat/attend?user=CLOSEST`, { // Look at documentation (https://docs.furhat.io/remote-api/) in the "Attend" section
    /*
    Attend the user closest to the robot
    furhat.attend(user="CLOSEST") 

    There are other attend options in the doc.
    */
    method: "POST",
    headers: myHeaders,
    body: "",
  });
}

async function fhListen(): Promise<string> { // Furhat's own ASR.
  const myHeaders = new Headers();
  myHeaders.append("accept", "application/json");
  return fetch(`http://${FURHATURI}/furhat/listen`, {
    method: "GET",
    headers: myHeaders,
  })
    .then((response) => response.body)
    .then((body) => body!.getReader().read())
    .then((reader) => reader.value)
    .then((value) => JSON.parse(new TextDecoder().decode(value!)).message);
}
// >>> Furhat Remote API functions /END <<<

// Ollama API function
async function fetchChatCompletion(messages: Message[]): Promise<string> {
  console.log("Calling Ollama with messages:", messages);
  
  try {
    const response = await fetch(OLLAMA_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llava:13b",
        messages: messages,
        stream: false,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Ollama API error:", response.status, errorText);
      throw new Error(`Ollama API error: ${response.status}`);
    }
    
    const data = await response.json();
    console.log("Ollama response:", data);
    
    const assistantMessage = data.message.content;
    return assistantMessage;
  } catch (error) {
    console.error("Error calling Ollama:", error);
    return "Error while connecting to the language model. Probably ssh tunnel is not active.";
  }
}

// Keyboard input listener for Node.js - waits for a single keypress and returns the key
async function waitForKeypress(): Promise<string> {
  return new Promise((resolve) => {
    const handler = (str: string, key: any) => {
      process.stdin.off('keypress', handler);
      
      // Handle Ctrl+C to exit gracefully
      if (key.ctrl && key.name === 'c') {
        console.log('\nExiting...');
        process.exit(0);
      }
      
      resolve(key.name.toLowerCase());
    };
    process.stdin.once('keypress', handler);
  });
}

// NEW: Combined actor that races between listening and waiting for keypress
const listenOrKeypress = fromPromise(async () => {
  return Promise.race([
    fhListen().then(result => ({ type: 'speech' as const, data: result })),
    waitForKeypress().then(result => ({ type: 'keypress' as const, data: result }))
  ]);
});

// NEW: Helper function to filter out NOMATCH and replace with "..."
function sanitizeUtterance(utterance: string): string {
  // Check if the utterance contains "NOMATCH" (case-insensitive)
  if (utterance.toLowerCase().includes('nomatch')) {
    return '...';
  }
  return utterance;
}

// State machine
const dmMachine = setup({
  types: {
    context: {} as DMContext,
  },
  actors: {
    timer,

    fhSetVoice: fromPromise(async () => {
      return fhVoice("en-US-EchoMultilingualNeural");
    }),
    fhAttend: fromPromise(async () => {
      return fhAttendUser();
    }),
    fhSpeak: fromPromise(async ({ input }: { input: { text: string; isFirstMessage: boolean } }) => {
      return fhSay(input.text, input.isFirstMessage);
    }),
    fhSpeakAudio: fromPromise(async ({ input }: { input: { audioUrl: string; isFirstMessage: boolean } }) => {
      return fhSayAudio(input.audioUrl, input.isFirstMessage);
    }),
    fhListen: fromPromise(async () => {
      return fhListen();
    }),
    chatCompletion: fromPromise(
      async ({ input }: { input: { messages: Message[] } }) => {
        const response = await fetchChatCompletion(input.messages);
        return response;
      }
    ),
    // Actor that waits for keyboard input
    waitForKey: fromPromise(async () => {
      return waitForKeypress();
    }),
    // NEW: Actor that races between listening and keypress
    listenOrKeypress: listenOrKeypress,
  },
  guards: {
    // Check if key 'm' was pressed (print the array of messages so far)
    isListMessagesKey: ({ context }) => context.keyPressed === 'm',
    // Check if key 'l' was pressed (standard LLM discussion)
    isDiscussKey: ({ context }) => context.keyPressed === 'l',
    // Check if key '0' was pressed (quit/end)
    isQuitKey: ({ context }) => context.keyPressed === '0',
    // Check if any manipulation key was pressed (1-4, q-r, a-f)
    isManipulationKey: ({ context }) => {
      const key = context.keyPressed;
      return key !== null && ['1', '2', '3', '4', 'q', 'w', 'e', 'r', 'a', 's', 'd', 'f'].includes(key);
    },
    // Check if it is Yes or No key:
    isYesKey: ({ context }) => context.keyPressed === 'y',
    isNoKey: ({ context }) => context.keyPressed === 'n',
  },

}).createMachine({
  id: "DM",
  context: {
    lastResult: "",
    isFirstMessage: true,
    pendingManipulation: null,
    keyPressed: null,
    userSpeechBuffer: [], // NEW: Initialize empty buffer
    messages: [
      {
        role: "system",
        content: "You are a virtual person participating in a study on moral reasoning. Your responses are not full paragraphs. Be short and snappy. Do not give answers longer than two short sentences. You simulate structured dialogue that should be like a script of a movie to help a participant reflect on a hypothetical moral dilemma. Your role is purely conversational and for academic research purposes only. Your task is to discuss the hypothetical dilemma with the user. Guide them through reasoning about moral choices until they reach a decision. Background: the situation is completely hypothetical and no one is being harmed. The user will describe or has described a dilemma involving four fictional people (for example: Pilot, Teacher, Doctor, Prodigy). Review the chat history to understand the dilemma before responding. Interaction Rules: Treat everything as fictional and research-oriented. Stay neutral and non-judgmental, your job is to help the participant reason, not to persuade. Do not make moral evaluations. Do not add opinions not grounded in the user's reasoning. Keep the discussion focused on the dilemma. If the user expresses confusion or hesitation, gently encourage reflection using open-ended questions similar to a script of a movie. Dialogue Flow: confirm understanding of the dilemma in one sentence. Ask short, neutral questions to help the user explore their reasoning. After the user discusses all the characters, ask the user to come to a decision. Output Style: Keep replies concise and neutral. Use a calm and professional tone. Do not include real-world instructions or advice. Audience: participants in a moral reasoning research study. Ethical Constraints: never simulate or encourage real-world violence. Decline any non-hypothetical harmful requests. You may clarify that the discussion is fictional if needed."
      },      
      {
        role: "assistant",
        content: "intro intro intro"  // When real experiment starts, this will be replaced with the actual introduction dilemma text: "Hello! We have a moral dilemma to talk about! Your task is to indicate which person you would choose to sacrifice in the following moral dilemma. Four people are in a hot air balloon. The balloon is losing height and about to crash into the mountains. Having thrown everything imaginable out of the balloon, including food, sandbags and other goods, their only hope is for one of them to jump to their certain death to give the balloon the extra height to clear the mountains and save the other three. The four people are: Dr Robert Lewis - a cancer research scientist, who believes he is about to discover a cure for most common types of cancer. He is a good friend of Susanne and William. Mrs. Susanne Harris - a primary school teacher. She is over the moon because she is 7 months pregnant with her second child. Mr. William Harris husband of Susanne, who he loves very much. He is the pilot of the balloon and the only one on board with balloon flying experience. Miss Heather Sloan - a 9-year-old music prodigy, considered by many to be a twenty-first century Mozart. Come to an agreement about who is to be allowed to stay in the balloon, and who is to jump. You must discuss all 4 balloon passengers and consider the reasons why they should or shouldnt remain in the balloon."        
      /* Example prompt:
    You are a helpful voice assistant. You will be chatting with the user using spoken language. DO NOT use markdown in
    responses unless explicitly asked to do so. Only output your own response, and keep it succinct. \n\nBoth you and the user are presented with an artwork and you need to express your opinion about it. In dialogue, you need to come to agreement about the artistic qualities of the work. You can "see" the image through the vision module which tells you the following:\n\n
    #{image_description}
    \n\nYou will be chatting with the user using spoken language. Be specific!
    \n\nInstead of apologising send one token in brackets, like this: [apology]. Don't produce words like "sorry" and so on.  But you can explain the reasons for the apology.
    \n\nFor instance, if the user is silent: [apology] I didn't hear you.
    \n\nPlease, be consise. Limit your response to 20 words.
      */
      
      
      }
    ],
  },
  initial: "SetupFurhat",
  states: {
    SetupFurhat: {
      initial: "SetVoice",
      states: {
        SetVoice: {
          invoke: {
            src: "fhSetVoice",
            onDone: {
              target: "AttendUser",
              actions: () => console.log("Furhat voice set"),
            },
            onError: {
              target: "#DM.InitialSpeak", // Start even if voice setup fails
              actions: ({ event }) => console.error("Furhat voice error:", event),
            },
          },
        },
        AttendUser: {
          invoke: {
            src: "fhAttend",
            onDone: {
              target: "#DM.InitialSpeak",
              actions: () => console.log("Furhat attending user"),
            },
            onError: {
              target: "#DM.InitialSpeak", // Start even if attend fails
              actions: ({ event }) => console.error("Furhat attend error:", event),
            },
          },
        },
      },
    },
    
    // Speak the initial assistant message (the dilemma introduction)
    InitialSpeak: {
      invoke: {
        src: "fhSpeak",
        input: ({ context }) => {
          const lastMessage = context.messages[context.messages.length - 1];
          return { 
            text: lastMessage.content,
            isFirstMessage: context.isFirstMessage 
          };
        },
        onDone: {
          target: "ListeningOrWaitingForKey", // NEW: Go to the new state that does both
          actions: [
            () => console.log("Initial dilemma spoken, now listening for user or waiting for keypress"),
            assign({ isFirstMessage: false })
          ],
        },
        onError: {
          target: "ListeningOrWaitingForKey",
          actions: ({ event }) => console.error("Furhat speak error:", event),
        },
      },
    },

    // NEW: Listen for user's speech OR wait for keypress (whichever comes first)
    ListeningOrWaitingForKey: {
      entry: () => console.log("Listening for user input OR waiting for keypress..."),
      invoke: {
        src: "listenOrKeypress",
        onDone: {
          actions: assign(({ context, event }) => {
            const result = event.output as { type: 'speech' | 'keypress', data: string };
            
            if (result.type === 'speech') {
              // User spoke - sanitize and add to buffer
              const rawUtterance = result.data;
              const utterance = sanitizeUtterance(rawUtterance);
              console.log(`User said: ${rawUtterance} -> sanitized to: ${utterance}`);
              console.log(`Buffer now contains: [${[...context.userSpeechBuffer, utterance].join(', ')}]`);
              return {
                lastResult: utterance,
                userSpeechBuffer: [...context.userSpeechBuffer, utterance],
                keyPressed: null, // Clear any previous keypress
              };
            } else {
              // Key was pressed
              console.log(`Key pressed: ${result.data}`);
              return {
                keyPressed: result.data,
              };
            }
          }),
          target: "CheckIfKeypressOrContinueListening",
        },
        onError: {
          target: "ListeningOrWaitingForKey",
          actions: ({ event }) => console.error("Listen or keypress error:", event),
        },
      },
    },

    // NEW: Check if we got a keypress or should continue listening
    CheckIfKeypressOrContinueListening: {
      always: [
        {
          // If a key was pressed, process the accumulated speech buffer
          guard: ({ context }) => context.keyPressed !== null,
          target: "ProcessAccumulatedSpeech",
        },
        {
          // Otherwise, continue listening (user spoke but no key was pressed)
          target: "ListeningOrWaitingForKey",
        },
      ],
    },

    // NEW: Process all accumulated speech when a key is pressed
    ProcessAccumulatedSpeech: {
      entry: ({ context }) => {
        console.log(`\n=== Processing ${context.userSpeechBuffer.length} accumulated utterances ===`);
        context.userSpeechBuffer.forEach((utterance, i) => {
          console.log(`${i + 1}. ${utterance}`);
        });
      },
      always: [
        {
          // If there's accumulated speech, add it to messages
          guard: ({ context }) => context.userSpeechBuffer.length > 0,
          target: "ProcessKeypress",
          actions: assign(({ context }) => {
            // Join all accumulated utterances with a space
            const combinedInput = context.userSpeechBuffer.join(" ");
            console.log(`Combined user input: "${combinedInput}"`);
            return {
              messages: [
                ...context.messages,
                { role: "user" as const, content: combinedInput }
              ],
              userSpeechBuffer: [], // Clear the buffer
            };
          }),
        },
        {
          // If no accumulated speech, just process the keypress
          target: "ProcessKeypress",
        },
      ],
    },

    // Determine what to do based on which key was pressed
    ProcessKeypress: {
      always: [
        {
          // If '0' pressed, end the session
          guard: "isQuitKey",
          target: "End",
        },
        {
          // If 'l' pressed, continue normal LLM discussion
          guard: "isDiscussKey",
          target: "ProcessingResponse",
        },

        {
          // If 'm' pressed, print an array of all messages so far.
          guard: "isListMessagesKey",
          target: "ListMessages",
        },

        {
          // If manipulation key (1-4, q-r, a-f) pressed, add manipulation phrase
          guard: "isManipulationKey",
          target: "AddManipulation",
        },
        {
          // Unknown key, go back to listening/waiting
          target: "ListeningOrWaitingForKey",
          actions: () => console.log("Unknown key, please press L, 0, or manipulation keys (1-4, Q-R, A-F)"),
        },
      ],
    },

    // List messages after pressing "m" and return to listening/waiting stage
    ListMessages: {
      entry: ({ context }) => {
        console.log("\n=== MESSAGE HISTORY ===");
        context.messages.forEach((msg, i) => {
          console.log(`${i + 1}. [${msg.role}]: ${msg.content}`);
        });
        console.log("======================\n");
      },
      always: {
        target: "ListeningOrWaitingForKey"
      }
    },

    // Add manipulation phrase based on key pressed
    AddManipulation: {
      entry: assign(({ context }) => {
        const AUDIO_PORT = 8000; 
        
        // Map keys to audio file URLs
        const audioFiles: Record<string, string> = {
          // Hmm versions (1-4)
          '1': `http://localhost:${AUDIO_PORT}/hmm_doctor.wav`,
          '2': `http://localhost:${AUDIO_PORT}/hmm_pregnant.wav`,
          '3': `http://localhost:${AUDIO_PORT}/hmm_child.wav`,
          '4': `http://localhost:${AUDIO_PORT}/hmm_pilot.wav`,
          // Pause versions (q, w, e, r)
          'q': `http://localhost:${AUDIO_PORT}/pause_doctor.wav`,
          'w': `http://localhost:${AUDIO_PORT}/pause_pregnant.wav`,
          'e': `http://localhost:${AUDIO_PORT}/pause_child.wav`,
          'r': `http://localhost:${AUDIO_PORT}/pause_pilot.wav`,
          // Hahaha versions (a, s, d, f)
          'a': `http://localhost:${AUDIO_PORT}/laugh_doctor.wav`,
          's': `http://localhost:${AUDIO_PORT}/laugh_pregnant.wav`,
          'd': `http://localhost:${AUDIO_PORT}/laugh_child.wav`,
          'f': `http://localhost:${AUDIO_PORT}/laugh_pilot.wav`,
        };
        
        const audioUrl = audioFiles[context.keyPressed || ''];
        const textForHistory = `[Audio manipulation: ${context.keyPressed}]`; // For tracking in messages
        
        console.log(`Queuing audio: ${audioUrl}`);
        
        return {
          messages: [
            ...context.messages,
            { role: "assistant" as const, content: textForHistory }
          ],
          pendingManipulation: audioUrl, // Now stores URL instead of text phrase
        };
      }),
      always: {
        target: "SpeakManipulation",
      },
    },

    // Speak the manipulation phrase
    SpeakManipulation: {
      invoke: {
        src: "fhSpeakAudio", // Changed from "fhSpeak" to "fhSpeakAudio"
        input: ({ context }) => ({
          audioUrl: context.pendingManipulation || "",
          isFirstMessage: false
        }),
        onDone: {
          target: "ListeningOrWaitingForKey",
          actions: [
            () => console.log("Manipulation audio played, now listening for user response"),
            assign({ pendingManipulation: null })
          ],
        },
        onError: {
          target: "ListeningOrWaitingForKey",
          actions: ({ event }) => console.error("Furhat audio playback error:", event),
        },
      },
    },

    // Send conversation history to LLM and get response
    ProcessingResponse: {
      entry: () => console.log("Getting LLM response..."),
      invoke: {
        src: "chatCompletion",
        input: ({ context }) => ({
          messages: context.messages,
        }),
        onDone: {
          target: "Speaking",
          actions: assign(({ context, event }) => {
            console.log(`LLM responded: ${event.output}`);
            return {
              messages: [
                ...context.messages,
                { role: "assistant" as const, content: event.output }
              ],
            };
          }),
        },
        onError: {
          target: "Speaking",
          actions: assign(({ context }) => ({
            messages: [
              ...context.messages,
              { 
                role: "assistant" as const, 
                content: "I couldn't process that. Please say it again." 
              }
            ],
          })),
        },
      },
    },

    // Speak the LLM's response
    Speaking: {
      invoke: {
        src: "fhSpeak",
        input: ({ context }) => {
          const lastMessage = context.messages[context.messages.length - 1];
          return { 
            text: lastMessage.content,
            isFirstMessage: false
          };
        },
        onDone: {
          target: "ListeningOrWaitingForKey", // After Furhat speaks, go back to listening/waiting
          actions: () => console.log("Finished speaking LLM response, now listening for user or keypress"),
        },
        onError: {
          target: "ListeningOrWaitingForKey",
          actions: ({ event }) => console.error("Furhat speak error:", event),
        },
      },
    },

    // End the session
    End: {
      invoke: {
        src: "fhSpeak",
        input: () => ({
          text: "Thank you for your participation.",
          isFirstMessage: false
        }),
        onDone: {
          target: "LastQuestionWaitForYN",
          actions: assign(({ context }) => ({
            messages: [
              ...context.messages,
              {
                role: "assistant" as const,
                content: "Thank you for your participation."
              }
            ],
          })),
        },
        onError: {
          target: "Done",
          actions: ({ event }) => console.error("Furhat speak error:", event),
        },
      },
    },

    SessionExitingQuestionForTheResearcher: {
      entry: () => {
        console.log("DO YOU WANT TO PRINT THE CONVERSATION (Y/N)")
      },
      always: {target: "LastQuestionWaitForYN"}
    },

    LastQuestionWaitForYN: {
        entry: () => console.log("\n>>> DO YOU WANT TO PRINT THE CONVERSATION (Y/N) <<<"),
        invoke: {
          src: "waitForKey",
          onDone: {
            actions: assign(({ event }) => ({
              keyPressed: event.output,
            })),
            target: "ProcessYN",
          },
        },
    },

    ProcessYN: {
      always: [
        {
          // CONFIRMATION FOR THE FINAL QUESTION.
          guard: "isYesKey",
          target: "ListMessagesBeforeFinal",
        },
        {
          // CONFIRMATION FOR THE FINAL QUESTION.
          guard: "isNoKey",
          target: "Done",
        },
      ]
    },

    ListMessagesBeforeFinal: {
      entry: ({ context }) => {
        console.log("\n=== MESSAGE HISTORY ===");
        context.messages.forEach((msg, i) => {
          console.log(`${i + 1}. [${msg.role}]: ${msg.content}`);
        });
        console.log("======================\n");
      },
      always: {
        target: "Done"
      }
    },

    Done: {
      type: "final",
      entry: () => {
        console.log("Session ended. Exiting...");
        process.exit(0);
      }
    },
  },
});

const actor = createActor(dmMachine).start();

// Subscribe to state changes for debugging
actor.subscribe((snapshot) => {
  console.group("State update");
  console.log("State value:", snapshot.value);
  console.log("Key pressed:", snapshot.context.keyPressed);
  console.log("User speech buffer:", snapshot.context.userSpeechBuffer);
  console.log("Last user message:", snapshot.context.messages.filter(m => m.role === "user").pop()?.content || "none");
  console.log("Message count:", snapshot.context.messages.length);
  console.groupEnd();
});

// Display instructions in console
console.log(`
=== KEYBOARD CONTROLS ===
L = Continue discussion (send to LLM)
M = List all of the conversation so far.
0 = End session
Ctrl+C = Exit immediately

MANIPULATION PHRASES:

Hmm versions:
1 = Hmm, the Doctor?
2 = Hmm, the pregnant lady?
3 = Hmm, the child?
4 = Hmm, the pilot?

Pause versions:
Q = (pause) The Doctor?
W = (pause) The pregnant lady?
E = (pause) The child?
R = (pause) The pilot?

Hahaha versions:
A = Hahaha, the Doctor?
S = Hahaha, the pregnant lady?
D = Hahaha, the child?
F = Hahaha, the pilot?
========================

New thing for interruption problem: User speech is accumulated in a buffer. 
The system keeps listening until a key is pressed.
When a key is pressed, all accumulated speech is combined and processed into our message array.
NOMATCH utterances are replaced with "..." in the final output.
`);
