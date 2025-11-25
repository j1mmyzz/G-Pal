const connectButton = document.getElementById("connect-gcal");
connectButton.style.display = "none"; // hide initially

function addMessage(sender, text) {
  const chat = document.getElementById("chat");
  const p = document.createElement("p");
  p.innerText = `${sender}: ${text}`;
  chat.appendChild(p);
}

async function checkConnection() {
  const res = await fetch("http://localhost:3000/auth/status");
  const data = await res.json();

  console.log("Connected status:", data.connected);

  if (data.connected) {
    connectButton.style.display = "none";
  } else {
    connectButton.style.display = "block";
  }
}

checkConnection();

connectButton.addEventListener("click", () => {
  chrome.tabs.create({ url: "http://localhost:3000/auth/google" });
});

async function sendMessage(text) {
  console.log("Preparing to send:", text);

  const res = await fetch("http://localhost:3000/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text }),
  });

  console.log("Response status:", res.status);

  const data = await res.json();
  console.log("Backend replied:", data);
  addMessage("G-Pal", data.reply); // for chatbot like feature
  return data.reply;
}

const input = document.getElementById("input");
const button = document.getElementById("send");

button.addEventListener("click", async () => {
  const text = input.value.trim();
  if (!text) return;
  console.log("Sending message from button:", text);
  addMessage("You", input.value);
  const reply = await sendMessage(text);
  console.log("Backend replied:", reply);
  input.value = "";
});

input.addEventListener("keyup", async (e) => {
  if (e.key === "Enter") {
    const text = input.value.trim();
    if (!text) return;
    console.log("Sending message from Enter:", text);
    addMessage("You", input.value);
    const reply = await sendMessage(text);
    console.log("Backend replied:", reply);
    input.value = "";
  }
});
