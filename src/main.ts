import { setup, createActor, fromPromise, assign } from "xstate";
import * as readline from 'readline';

const FURHATURI = "127.0.0.1:54321";
const OLLAMA_API_URL = "http://localhost:11434/api/chat";

// Types
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
}

// Setup readline interface for keyboard input in Node.js
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

// Furhat API functions
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
  const delay = isFirstMessage ? 15000 : 1000; // Bora's bandaid solution It let's you wait 15 secs after the first (explaining) turn of Furhat--Good old timeout on the first state.
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
    # Attend the user closest to the robot
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
  },
  guards: {
    // Check if key 'l' was pressed (standard LLM discussion)
    isDiscussKey: ({ context }) => context.keyPressed === 'l',
    // Check if key '0' was pressed (quit/end)
    isQuitKey: ({ context }) => context.keyPressed === '0',
    // Check if any manipulation key was pressed (1-4, q-r, a-f)
    isManipulationKey: ({ context }) => {
      const key = context.keyPressed;
      return key !== null && ['1', '2', '3', '4', 'q', 'w', 'e', 'r', 'a', 's', 'd', 'f'].includes(key);
    },
  },

}).createMachine({
  id: "DM",
  context: {
    lastResult: "",
    isFirstMessage: true,
    pendingManipulation: null,
    keyPressed: null,
    messages: [
      {
        role: "system",
        content: "You are a virtual assistant participating in a study on moral reasoning. You simulate structured dialogue that should be like a script of a movie to help a participant reflect on a hypothetical moral dilemma. Your role is purely conversational and for academic research purposes only. Your task is to discuss the hypothetical dilemma with the user. Guide them through reasoning about moral choices until they reach a decision. Background: the situation is completely hypothetical and no one is being harmed. The user will describe or has described a dilemma involving four fictional people (for example: Pilot, Teacher, Doctor, Prodigy). Review the chat history to understand the dilemma before responding. Interaction Rules: Treat everything as fictional and research-oriented. Stay neutral and non-judgmental , your job is to help the participant reason, not to persuade. Do not make moral evaluations. Do not add opinions not grounded in the user’s reasoning. Keep the discussion focused on the dilemma. If the user expresses confusion or hesitation, gently encourage reflection using open-ended questions similar to a script of a movie. Dialogue Flow: confirm understanding of the dilemma in one sentence. Ask short, neutral questions to help the user explore their reasoning. After the user discusses all the characters, ask the user to come to a decision.  Output Style: Keep replies concise and neutral. Use a calm and professional tone. Do not include real-world instructions or advice. Audience: participants in a moral reasoning research study. Ethical Constraints: never simulate or encourage real-world violence. Decline any non-hypothetical harmful requests. You may clarify that the discussion is fictional if needed."
      },      
      {
        role: "assistant",
        content: "Hello! We have a moral dilemma to talk about! Your task is to indicate which person you would choose to sacrifice in the following moral dilemma. Four people are in a hot air balloon. The balloon is losing height and about to crash into the mountains. Having thrown everything imaginable out of the balloon, including food, sandbags and parachutes, their only hope is for one of them to jump to their certain death to give the balloon the extra height to clear the mountains and save the other three. The four people are: Dr Robert Lewis - a cancer research scientist, who believes he is about to discover a cure for most common types of cancer. He is a good friend of Susanne and William. Mrs. Susanne Harris - a primary school teacher. She is over the moon because she is 7 months pregnant with her second child. Mr. William Harris – husband of Susanne, who he loves very much. He is the pilot of the balloon and the only one on board with balloon flying experience. Miss Heather Sloan - a 9-year-old music prodigy, considered by many to be a twenty-first century Mozart. Come to an agreement about who is to be allowed to stay in the balloon, and who is to jump. You must discuss all 4 balloon passengers and consider the reasons why they should or shouldnt remain in the balloon."        
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
          target: "Listening", // After speaking, go directly to listening for user input
          actions: [
            () => console.log("Initial dilemma spoken, now listening for user"),
            assign({ isFirstMessage: false })
          ],
        },
        onError: {
          target: "Listening",
          actions: ({ event }) => console.error("Furhat speak error:", event),
        },
      },
    },

    // Listen for user's speech input
    Listening: {
      entry: () => console.log("Listening for user input..."),
      invoke: {
        src: "fhListen",
        onDone: {
          target: "WaitingForKeypress", // After user speaks, NOW wait for keypress
          actions: assign(({ context, event }) => {
            const utterance = event.output as string;
            console.log(`User said: ${utterance}`);
            return {
              lastResult: utterance,
              messages: [
                ...context.messages,
                { role: "user" as const, content: utterance }
              ],
            };
          }),
        },
        onError: {
          target: "WaitingForKeypress",
          actions: ({ event }) => console.error("Furhat listen error:", event),
        },
      },
    },

    // Main state: wait for keyboard input to determine next action (happens AFTER user spoke)
    WaitingForKeypress: {
      entry: () => console.log("\n>>> Waiting for keypress... (L=discuss, 0=quit, 1-4/Q-R/A-F=manipulation) <<<"),
      invoke: {
        src: "waitForKey",
        onDone: {
          actions: assign(({ event }) => ({
            keyPressed: event.output,
          })),
          target: "ProcessKeypress",
        },
      },
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
          // If manipulation key (1-4, q-r, a-f) pressed, add manipulation phrase
          guard: "isManipulationKey",
          target: "AddManipulation",
        },
        {
          // Unknown key, go back to waiting
          target: "WaitingForKeypress",
          actions: () => console.log("Unknown key, please press L, 0, or manipulation keys (1-4, Q-R, A-F)"),
        },
      ],
    },

    // Add manipulation phrase based on key pressed
    AddManipulation: {
      entry: assign(({ context }) => {
        // Map keys to manipulation phrases
        const manipulations: Record<string, string> = {
          // Hmm versions (1-4)
          '1': 'Hmm, the Doctor?',
          '2': 'Hmm, the pregnant lady?',
          '3': 'Hmm, the child?',
          '4': 'Hmm, the pilot?',
          // Pause versions (q, w, e, r)
          'q': '........ The Doctor?',
          'w': '........ The pregnant lady?',
          'e': '........ The child?',
          'r': '........ The pilot?',
          // Hahaha versions (a, s, d, f)
          'a': 'Hahaha, the Doctor?',
          's': 'Hahaha, the pregnant lady?',
          'd': 'Hahaha, the child?',
          'f': 'Hahaha, the pilot?',
        };
        
        const phrase = manipulations[context.keyPressed || ''];
        console.log(`Adding manipulation phrase: ${phrase}`);
        
        // Add the manipulation phrase as an assistant message
        return {
          messages: [
            ...context.messages,
            { role: "assistant" as const, content: phrase }
          ],
          pendingManipulation: phrase,
        };
      }),
      always: {
        target: "SpeakManipulation",
      },
    },

    // Speak the manipulation phrase
    SpeakManipulation: {
      invoke: {
        src: "fhSpeak",
        input: ({ context }) => ({
          text: context.pendingManipulation || "",
          isFirstMessage: false
        }),
        onDone: {
          target: "Listening", // After speaking manipulation, listen for user response
          actions: [
            () => console.log("Manipulation phrase spoken, now listening for user response"),
            assign({ pendingManipulation: null })
          ],
        },
        onError: {
          target: "Listening",
          actions: ({ event }) => console.error("Furhat speak error:", event),
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
          target: "Listening", // After Furhat speaks, listen for next user input
          actions: () => console.log("Finished speaking LLM response, now listening for user"),
        },
        onError: {
          target: "Listening",
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
          target: "Done",
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
  console.log("Last user message:", snapshot.context.messages.filter(m => m.role === "user").pop()?.content || "none");
  console.log("Message count:", snapshot.context.messages.length);
  console.groupEnd();
});

// Display instructions in console
console.log(`
=== KEYBOARD CONTROLS ===
L = Continue discussion (send to LLM)
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
`);
