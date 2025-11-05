import { setup, createActor, fromPromise, assign } from "xstate";
//test
const FURHATURI = "127.0.0.1:54321";
const OLLAMA_API_URL = "http://localhost:11434/api/chat";

// Types
type Message = {
  role: "assistant" | "user" | "system";
  content: string;
};

interface DMContext {
  lastResult: string;
  extractedPerson: string;
  messages: Message[];
  isFirstMessage: boolean;
}

// Furhat API functions
async function fhVoice(name: string) {
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
  const delay = isFirstMessage ? 15000 : 1000;
  await new Promise(resolve => setTimeout(resolve, delay));
}

async function fhAttendUser() {
  const myHeaders = new Headers();
  myHeaders.append("accept", "application/json");
  return fetch(`http://${FURHATURI}/furhat/attend?user=CLOSEST`, {
    method: "POST",
    headers: myHeaders,
    body: "",
  });
}

async function fhListen(): Promise<string> {
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

// Helper function to extract person from decision
function extractPersonFromDecision(utterance: string): string | null {
  const lower = utterance.toLowerCase().trim();
  const wantToJumpMatch = lower.match(/\bi\s+want\s+(?:the\s+)?(.+?)\s+to\s+jump\b/);
  if (wantToJumpMatch) {
    const person = wantToJumpMatch[1].trim();
    return person;
  }
  return null;
}

// State machine
const dmMachine = setup({
  types: {
    context: {} as DMContext,
  },
  actors: {
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
  },
  guards: {
    hasDecision: ({ context }) => {
      const lastUserMessage = context.messages
        .filter(m => m.role === "user")
        .pop();
      if (!lastUserMessage) return false;
      const extractedPerson = extractPersonFromDecision(lastUserMessage.content);
      return extractedPerson !== null;
    },
    saidYes: ({ context }) => {
      const lastResult = context.lastResult.toLowerCase().trim();
      return lastResult === "yes" || lastResult === "yeah" || 
             lastResult === "yep" || lastResult.includes("yes");
    },
    saidNo: ({ context }) => {
      const lastResult = context.lastResult.toLowerCase().trim();
      return lastResult === "no" || lastResult === "nope" || 
             lastResult.includes("no");
    },
  },
}).createMachine({
  id: "DM",
  context: {
    lastResult: "",
    extractedPerson: "",
    isFirstMessage: true,
    messages: [
      {
        role: "system",
        content: "You are a virtual assistant participating in a study on moral reasoning. You simulate structured dialogue to help a participant reflect on a hypothetical moral dilemma. Your role is purely conversational and for academic research purposes only. Your task is to discuss the hypothetical dilemma with the user. Guide them through reasoning about moral choices until they reach a decision. Background: the situation is completely hypothetical and no one is being harmed. The user will describe or has described a dilemma involving four fictional people (for example: Pilot, Teacher, Doctor, Prodigy). Review the chat history to understand the dilemma before responding. Interaction Rules: Treat everything as fictional and research-oriented. Stay neutral and non-judgmental, your job is to help the participant reason, not to persuade. Do not make moral evaluations. Do not add opinions not grounded in the user's reasoning. Keep the discussion focused on the dilemma. If the user expresses confusion or hesitation, gently encourage reflection using open-ended questions. Dialogue Flow: confirm understanding of the dilemma in one sentence. Ask short, neutral questions to help the user explore their reasoning. After the user discusses the character or characters, ask the user come to a decision. One example is: 'What makes you hesitate?' Another example is: 'Which value feels most important in this decision?', another example is: 'How do you think others in the scenario might feel?' Output Style: Keep replies concise and neutral (1 sentence). Use a calm and professional tone. Do not include real-world instructions or advice. Audience: participants in a moral reasoning research study. Ethical Constraints: never simulate or encourage real-world violence. Decline any non-hypothetical harmful requests. You may clarify that the discussion is fictional if needed."
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
              target: "#DM.Loop",
              actions: ({ event }) => console.error("Furhat voice error:", event),
            },
          },
        },
        AttendUser: {
          invoke: {
            src: "fhAttend",
            onDone: {
              target: "#DM.Loop",
              actions: () => console.log("Furhat attending user"),
            },
            onError: {
              target: "#DM.Loop",
              actions: ({ event }) => console.error("Furhat attend error:", event),
            },
          },
        },
      },
    },
    Loop: {
      initial: "Speaking",
      states: {
        Speaking: {
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
              target: "Listening",
              actions: [
                () => console.log("Furhat finished speaking"),
                assign({ isFirstMessage: false })
              ],
            },
            onError: {
              target: "Listening",
              actions: ({ event }) => console.error("Furhat speak error:", event),
            },
          },
        },
        Listening: {
          invoke: {
            src: "fhListen",
            onDone: [
              {
                guard: ({ event }) => {
                  const utterance = event.output as string;
                  const extractedPerson = extractPersonFromDecision(utterance);
                  return extractedPerson !== null;
                },
                target: "#DM.Manipulation",
                actions: assign(({ context, event }) => {
                  const utterance = event.output as string;
                  const extractedPerson = extractPersonFromDecision(utterance);
                  return {
                    lastResult: utterance,
                    extractedPerson: extractedPerson || "",
                    messages: [
                      ...context.messages,
                      { role: "user" as const, content: utterance }
                    ],
                  };
                }),
              },
              {
                target: "ProcessingResponse",
                actions: assign(({ context, event }) => {
                  const utterance = event.output as string;
                  return {
                    lastResult: utterance,
                    messages: [
                      ...context.messages,
                      { role: "user" as const, content: utterance }
                    ],
                  };
                }),
              },
            ],
            onError: {
              target: "Speaking",
              actions: ({ event }) => console.error("Furhat listen error:", event),
            },
          },
        },
        ProcessingResponse: {
          invoke: {
            src: "chatCompletion",
            input: ({ context }) => ({
              messages: context.messages,
            }),
            onDone: {
              target: "Speaking",
              actions: assign(({ context, event }) => ({
                messages: [
                  ...context.messages,
                  { role: "assistant" as const, content: event.output }
                ],
              })),
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
      },
    },
    Manipulation: {
      initial: "Speaking",
      states: {
        Speaking: {
          invoke: {
            src: "fhSpeak",
            input: ({ context }) => ({
              text: `Hmm, the ${context.extractedPerson}?`,
              isFirstMessage: false
            }),
            onDone: {
              target: "Listening",
              actions: () => console.log("Manipulation question spoken"),
            },
            onError: {
              target: "Listening",
              actions: ({ event }) => console.error("Furhat speak error:", event),
            },
          },
        },
        Listening: {
          invoke: {
            src: "fhListen",
            onDone: [
              {
                guard: ({ event }) => {
                  const utterance = (event.output as string).toLowerCase().trim();
                  return utterance === "yes" || utterance === "yeah" || 
                         utterance === "yep" || utterance.includes("yes");
                },
                target: "#DM.End",
                actions: assign(({ event }) => ({
                  lastResult: event.output as string,
                })),
              },
              {
                guard: ({ event }) => {
                  const utterance = (event.output as string).toLowerCase().trim();
                  return utterance === "no" || utterance === "nope" || 
                         utterance.includes("no");
                },
                target: "#DM.Loop.ProcessingResponse",
                actions: assign(({ context, event }) => ({
                  lastResult: event.output as string,
                  messages: [
                    ...context.messages,
                    { role: "user" as const, content: "I am not sure." }
                  ],
                })),
              },
              {
                target: "Clarify",
                actions: assign(({ event }) => ({
                  lastResult: event.output as string,
                })),
              },
            ],
            onError: {
              target: "Speaking",
              actions: ({ event }) => console.error("Furhat listen error:", event),
            },
          },
        },
        Clarify: {
          invoke: {
            src: "fhSpeak",
            input: () => ({
              text: "I didn't catch that. Did you say yes or no?",
              isFirstMessage: false
            }),
            onDone: {
              target: "Listening",
            },
            onError: {
              target: "Listening",
              actions: ({ event }) => console.error("Furhat speak error:", event),
            },
          },
        },
      },
    },
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
    },
  },
});

const actor = createActor(dmMachine).start();

actor.subscribe((snapshot) => {
  console.group("State update");
  console.log("State value:", snapshot.value);
  console.log("Extracted person:", snapshot.context.extractedPerson);
  console.log("Last user message:", snapshot.context.messages.filter(m => m.role === "user").pop()?.content || "none");
  console.groupEnd();
});
