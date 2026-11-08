if (location.protocol === "file:") {
  document.querySelector("#connection").textContent =
    "Open the hosted dashboard";
  const panel = document.createElement("main");
  panel.className = "wrap";
  const heading = document.createElement("h2");
  heading.textContent = "This dashboard needs its backend running";
  const explanation = document.createElement("p");
  explanation.textContent =
    "You opened the HTML file directly. Start the Vizor shared relay, then open its web address to load projects, tasks and agents.";
  const link = document.createElement("a");
  link.href = "http://127.0.0.1:4387/";
  link.textContent = "Open local dashboard";
  const help = document.createElement("p");
  help.textContent =
    "For a remote host or a different port, use that host’s dashboard address. Sign in as owner with the dashboard password configured on the host.";
  panel.append(heading, explanation, link, help);
  document.querySelector("main").replaceWith(panel);
} else {
  const script = document.createElement("script");
  script.type = "module";
  script.src = "./client.js";
  document.head.append(script);
}
