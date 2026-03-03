import zmq
import pyaudio

FURHAT_AUDIO_FEED = 'tcp://192.168.1.11:3001' # We got it from the website

# Setup ZMQ subscriber
context = zmq.Context()
socket = context.socket(zmq.SUB)
socket.connect(FURHAT_AUDIO_FEED)
socket.setsockopt_string(zmq.SUBSCRIBE, '')

print(f"Connected to Furhat audio feed at {FURHAT_AUDIO_FEED}")
print("Listening to participant microphone...")

# Setup audio output to your headphones
p = pyaudio.PyAudio()
stream = p.open(
    format=pyaudio.paInt16,
    channels=1,
    rate=16000,
    output=True
)

try:
    while True:
        # Receive stereo audio chunk
        audio_data = socket.recv()
        
        # Extract left channel (microphone) from stereo
        # Stereo format: [L_low, L_high, R_low, R_high, L_low, L_high, ...]
        mono_data = b''
        for i in range(0, len(audio_data), 4):
            mono_data += audio_data[i:i+2]  # Take left channel bytes
        
        # Play through headphones
        stream.write(mono_data)

except KeyboardInterrupt:
    print("\nStopping audio monitor...")
finally:
    stream.stop_stream()
    stream.close()
    p.terminate()
    socket.close()