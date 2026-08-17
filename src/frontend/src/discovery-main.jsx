import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import DiscoveryView from "./discovery-view.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <DiscoveryView />
  </StrictMode>
);
