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
import { LicenseInfo, muiXTelemetrySettings } from "@mui/x-license";
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
import BudgetSync from "./routes/nestedPages/budgetSync";
import Sync from "./routes/nestedPages/sync";
import DelegationPage from "./routes/nestedPages/delegation";
import AdminPage from "./routes/nestedPages/admin";
import BstPush from "./routes/nestedPages/bstPush";
import KpiDrivers from "./routes/nestedPages/kpiDrivers";
import ManualInput from "./routes/nestedPages/manualInput";
import HotelClusters from "./routes/nestedPages/hotelClusters";
import Allocations from "./routes/nestedPages/allocations";
import Positions from "./routes/nestedPages/positions";
import Results from "./routes/nestedPages/results";
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
        path: "budget-pull",
        element: <BudgetSync />,
        handle: { title: "BST Pull" },
      },
      {
        path: "bst-push",
        element: <BstPush />,
        handle: { title: "BST Push" },
      },
      {
        path: "kpi-drivers",
        element: <KpiDrivers />,
        handle: { title: "KPI Drivers" },
      },
      {
        path: "manual-input",
        element: <ManualInput />,
        handle: { title: "Manual Input" },
      },
      {
        path: "clusters",
        element: <HotelClusters />,
        handle: { title: "Clusters" },
      },
      {
        path: "positions",
        element: <Positions />,
        handle: { title: "Positions" },
      },
      {
        path: "allocations",
        element: <Allocations />,
        handle: { title: "Allocations" },
      },
      {
        path: "results",
        element: <Results />,
        handle: { title: "Results" },
      },
      {
        path: "sync",
        element: <Sync />,
        handle: { title: "Sync" },
      },
      {
        // Reached from the Sync page with ?plan=<scenario id>. Not in the nav:
        // delegation is always ABOUT a specific plan, and a nav entry would open
        // it with nothing selected.
        path: "delegation",
        element: <DelegationPage />,
        handle: { title: "Delegation" },
      },
      {
        // Also not in the nav. Reached from Settings → Support tools, which only
        // unlocks after the server has confirmed the account is an
        // administrator. The page refuses to render its own contents otherwise,
        // and every request behind it 403s regardless — this route being
        // reachable by URL gives nothing away.
        path: "admin",
        element: <AdminPage />,
        handle: { title: "Estate administration" },
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


// MUI X pings x-telemetry.mui.com from @mui/x-license during development. It is
// already a no-op in production builds, and our CSP blocks it in dev — this just
// stops the blocked-request errors from flooding the renderer console.
muiXTelemetrySettings.disableTelemetry();

LicenseInfo.setLicenseKey("4e66d921d752befefa9384a027675566Tz0xMTkzODcsRT0xNzkyMDIyMzk5MDAwLFM9cHJlbWl1bSxMTT1hbm51YWwsUFY9UTEtMjAyNixRPTEsQVQ9bXVsdGksS1Y9Mg==");

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
