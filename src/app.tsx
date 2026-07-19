import React from "react";
// Bundled fonts for the welcome scene (offline — no Google Fonts dependency):
// Inter 400–800 and IBM Plex Mono 400–600, matching the original design.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/inter/800.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
// Import specific functions and components
import { LicenseInfo } from "@mui/x-license";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, RouterProvider } from "react-router-dom";
import AppThemeProvider from "./components/AppThemeProvider";
import AppInitializer from "./components/AppInitializer";
import UiScaleController from "./components/UiScaleController";

//import routes
import SessionGate from "./routes/sessionGate";
import Register from "./routes/register";
import Login from "./routes/login";
import DeviceVerify from "./routes/device-verify";
import SignedInLanding from "./routes/signedinLanding";
import Profile from "./routes/nestedPages/profile";
import Settings from "./routes/nestedPages/settings";
import HelpSupport from "./routes/nestedPages/helpSupport";
import Home from "./routes/nestedPages/home";
import ProtectedRoute from "./components/ProtectedRoute";

// define the route
const router = createHashRouter([
  {
    path: "/",
    element: <SessionGate />,
  },
  {
    path: "/register",
    element: <Register />,
  },
  {
    path: "/login",
    element: <Login />,
  },
  {
    path: "/auth/device-verify",
    element: <DeviceVerify />,
  },
  {
    path: "/signed-in-landing",
    element: (
      <ProtectedRoute>
        <SignedInLanding />
      </ProtectedRoute>
    ),
    handle: { title: "Dashboard" },
    children: [
      {
        path: "home",
        element: <Home />,
        handle: { title: "Home" },
      },
      {
        path: "profile",
        element: <Profile />,
        handle: { title: "My Profile" },
      },
      {
        path: "settings",
        element: <Settings />,
        handle: { title: "Settings" },
      },
      {
        path: "help",
        element: <HelpSupport />,
        handle: { title: "Help & Support" },
      },
    ],
  },
]);

// MUI X Premium licence. This key is designed to be public — it is validated
// offline and is expected to appear in the JS bundle. Order 119387, annual
// subscription: any MUI X version released before 2026-10-13 works in
// production indefinitely; renew before then to keep upgrading in development.
LicenseInfo.setLicenseKey("0170f20369e51857b2536db7dfa0f38eTz0xMTkzODcsRT0xNzkxOTM1OTk5MDAwLFM9cHJlbWl1bSxMTT1zdWJzY3JpcHRpb24sUFY9aW5pdGlhbCxLVj0y");

//root document
createRoot(document.getElementById("root")).render(
  <StrictMode>
    {/* Theme provider wraps AppInitializer so its splash/loading screens are
        also rendered with the user's light/dark MUI theme. */}
    <AppThemeProvider>
      <AppInitializer>
        <UiScaleController />
        <RouterProvider router={router} />
      </AppInitializer>
    </AppThemeProvider>
  </StrictMode>
);
