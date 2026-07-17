import React from "react";
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
import DataTable from "./routes/nestedPages/dataTable";
import StagingDataReview from "./routes/nestedPages/stagingDataReview";
import SignedInLanding from "./routes/signedinLanding";
import Report from "./routes/nestedPages/report";
import CreateNew from "./routes/nestedPages/createNew";
import COA from "./routes/nestedPages/coa";
import DataImport from "./routes/nestedPages/dataImport";
import Validations from "./routes/nestedPages/validations";
import MappingReview from "./routes/nestedPages/mappingReview";
import Profile from "./routes/nestedPages/profile";
import Settings from "./routes/nestedPages/settings";
import HelpSupport from "./routes/nestedPages/helpSupport";
import Home from "./routes/nestedPages/home";
import SignOffUpload from "./routes/nestedPages/signOffUpload";
import BstImport from "./routes/nestedPages/bstImport";
import SummaryPL from "./routes/nestedPages/summaryPL";
import F90PL from "./routes/nestedPages/f90PL";
import RoomSegmentReview from "./routes/nestedPages/roomSegmentReview";
import ExcelExport from "./routes/nestedPages/excelExport";
import ProteaReportPack from "./routes/nestedPages/proteaReportPack";
import ProteaBudgetPack from "./routes/nestedPages/proteaBudgetPack";
import BSTExtract from "./routes/nestedPages/bstExtract";
import ProteaF90PL from "./routes/nestedPages/proteaF90PL";
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
        path: "data-import",
        element: <DataImport />,
        handle: { title: "Data Import" },
      },
      {
        path: "validations",
        element: <Validations />,
        handle: { title: "Validations" },
      },
      {
        path: "staging-review",
        element: <StagingDataReview />,
        handle: { title: "Staging Data Review" },
      },
      {
        path: "room-segment-review",
        element: <RoomSegmentReview />,
        handle: { title: "Room Seg. Review" },
      },
      {
        path: "sign-off-upload",
        element: <SignOffUpload />,
        handle: { title: "Sign-Off & Upload" },
      },
      {
        path: "bst-import",
        element: <BstImport />,
        handle: { title: "BST Import" },
      },
      {
        path: "report",
        element: <Report />,
        handle: { title: "Report" },
      },
      {
        path: "data-table",
        element: <DataTable />,
        handle: { title: "Upload Review" },
      },
      {
        path: "summary-pl",
        element: <SummaryPL />,
        handle: { title: "Summary P&L" },
      },
      {
        path: "f90-pl",
        element: <F90PL />,
        handle: { title: "F90 P&L" },
      },
      {
        path: "excel-export",
        element: <ExcelExport />,
        handle: { title: "Marriott Excel Report Pack" },
      },
      {
        path: "protea-f90-pl",
        element: <ProteaF90PL />,
        handle: { title: "Protea F90 P&L" },
      },
      {
        path: "protea-report-pack",
        element: <ProteaReportPack />,
        handle: { title: "Protea Report Pack" },
      },
      {
        path: "protea-budget-pack",
        element: <ProteaBudgetPack />,
        handle: { title: "Protea Budget Pack" },
      },
      {
        path: "protea-bst-extract",
        element: <BSTExtract />,
        handle: { title: "BST Extract" },
      },
      {
        path: "coa",
        element: <COA />,
        handle: { title: "COA" },
      },
      {
        path: "mapping-review",
        element: <MappingReview />,
        handle: { title: "Mapping Review" },
      },
      {
        path: "create-new",
        element: <CreateNew />,
        handle: { title: "Create New" },
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

// Set the license key
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
