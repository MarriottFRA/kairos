import React from "react";
import { Button } from "@mui/material";
import { Outlet, Routes, Route, Link } from "react-router-dom";
import { useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import Stepper from "@mui/material/Stepper";
import Step from "@mui/material/Step";
import StepLabel from "@mui/material/StepLabel";
import StepButton from "@mui/material/StepButton";
import Typography from "@mui/material/Typography";
import Grid from "@mui/material/Grid2";
import TextField from "@mui/material/TextField";
import Autocomplete from "@mui/material/Autocomplete";
import FormControl from "@mui/material/FormControl";
import FormHelperText from "@mui/material/FormHelperText";
import InputLabel from "@mui/material/InputLabel";
import OutlinedInput from "@mui/material/OutlinedInput";
import CalculateOutlinedIcon from "@mui/icons-material/CalculateOutlined";
import { v4 as uuidv4 } from "uuid";
import InputAdornment from "@mui/material/InputAdornment";
import IconButton from "@mui/material/IconButton";

import Visibility from "@mui/icons-material/Visibility";
import VisibilityOff from "@mui/icons-material/VisibilityOff";

import EndAdornment from "../customComponents/adorment";
import AnimatedButton from "../customComponents/button";
// Removed RandomAdornment in favor of standard plus adornment

export default function CreateNew() {
  const navigate = useNavigate();

  //non data variables used for conmponent state and control
  const [activeStep, setActiveStep] = React.useState(0); //active step
  const [skipped, setSkipped] = React.useState(new Set<number>()); //skipped steps
  const [enableCity, setEnableCity] = React.useState<boolean>(false); //enable the drop down box

  // data values
  const [hotelName, setHotelName] = React.useState<string>(""); // hotel name data value
  const [testValue, setTestValue] = React.useState<string>(""); // test value data value
  const [testValueStart, setTestValueStart] = React.useState<string>(""); // test value with start button

  // basic callbacks for value updates
  //------------------------------------------
  const handleHotelNameChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setHotelName(e.target.value);
  }, []);

  const handleTestValueChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setTestValue(e.target.value);
  }, []);

  const handleTestValueStartChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setTestValueStart(e.target.value);
  }, []);

  const setEnableCityChange = React.useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setEnableCity(e.target.value == "");
  }, []);

  const newHotelId = uuidv4();
  // demo function to generate hotel name
  //------------------------------------------
  const handleHotelNameGeneration = async (): Promise<boolean> => {
    const randomAdjectives = ["Sunny", "Cozy", "Elegant", "Majestic", "Rustic", "Luxury", "Serene", "Grand", "Charming"];
    const randomNouns = ["Resort", "Inn", "Lodge", "Suites", "Palace", "Retreat", "Escape", "Hideaway", "Sanctuary"];
    const randomSuffixes = ["& Spa", "Plaza", "Boutique", "Collection", "Deluxe", "Residences", "Tower", "Villa"];

    const getRandomElement = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];

    const randomName = `${getRandomElement(randomAdjectives)} ${getRandomElement(randomNouns)} ${Math.floor(Math.random() * 100)} ${getRandomElement(
      randomSuffixes
    )}`;

    return new Promise((resolve) => {
      setHotelName(randomName);
      resolve(true);
    });
  };

  // validate test value based on length
  //------------------------------------------
  const handleTestValueValidate = React.useCallback(async (): Promise<boolean> => {
    return new Promise((resolve) => {
      const isValid = testValue.length < 10;
      resolve(isValid);
    });
  }, [testValue]);

  const handleTestValueStartValidate = React.useCallback(async (): Promise<boolean> => {
    return new Promise((resolve) => {
      const randomNumber = Math.floor(Math.random() * 10) + 1;
      setTestValueStart(randomNumber.toString());
      const isValid = randomNumber < 5;
      resolve(isValid);
    });
  }, []);

  // demo function to simulate async operation
  //------------------------------------------
  const simulateAsyncOperation = async (): Promise<boolean> => {
    return new Promise((resolve) => {
      setTimeout(() => {
        const isSuccess = Math.random() > 0.5; // Randomly succeed or fail
        resolve(isSuccess);
      }, 400); // 1.5 seconds delay to simulate async work
    });
  };

  // Stepper functions
  //------------------------------------------
  const totalSteps = 5; // Update this when adding more steps
  const isStepOptional = (step: number) => {
    return step === 1;
  };
  const isStepSkipped = (step: number) => {
    return skipped.has(step);
  };
  const handleNext = () => {
    let newSkipped = skipped;
    if (isStepSkipped(activeStep)) {
      newSkipped = new Set(newSkipped);
      newSkipped.delete(activeStep);
    }
    setActiveStep((prevActiveStep) => prevActiveStep + 1);
    setSkipped(newSkipped);
  };
  const handleBack = () => {
    setActiveStep((prevActiveStep) => prevActiveStep - 1);
  };
  const handleSkip = () => {
    if (!isStepOptional(activeStep)) {
      throw new Error("You can't skip a step that isn't optional.");
    }
    setSkipped((prevSkipped) => {
      const newSkipped = new Set(prevSkipped);
      newSkipped.add(activeStep);
      return newSkipped;
    });
    setActiveStep((prevActiveStep) => prevActiveStep + 1);
  };
  const handleReset = () => {
    setActiveStep(0);
    setSkipped(new Set<number>());
  };

  // Render the component
  //------------------------------------------
  return (
    <Box sx={{ width: "100%" }}>
      <Stepper activeStep={activeStep} alternativeLabel>
        <Step completed={activeStep > 0 && !isStepSkipped(0)}>
          <StepLabel>Base Hotel Metadata</StepLabel>
        </Step>
        <Step completed={activeStep > 1 && !isStepSkipped(1)}>
          <StepLabel optional={isStepOptional(1) ? <Typography variant="caption">Optional</Typography> : null}>Setup Departments</StepLabel>
        </Step>
        <Step completed={activeStep > 2 && !isStepSkipped(2)}>
          <StepLabel>Setup Outlets</StepLabel>
        </Step>
        <Step completed={activeStep > 3 && !isStepSkipped(3)}>
          <StepLabel>Review Staffing</StepLabel>
        </Step>
        <Step completed={activeStep > 4 && !isStepSkipped(4)}>
          <StepLabel>Review Costs</StepLabel>
        </Step>
      </Stepper>
      {activeStep === totalSteps ? (
        <React.Fragment>
          <Typography sx={{ mt: 2, mb: 1 }}>All steps completed - you're finished</Typography>
          <Box sx={{ display: "flex", flexDirection: "row", pt: 2 }}>
            <Box sx={{ flex: "1 1 auto" }} />
            <Button onClick={handleReset}>Reset</Button>
          </Box>
        </React.Fragment>
      ) : (
        <React.Fragment>
          {/* Render content for each step */}
          {activeStep === 0 && (
            <Box sx={{ flexGrow: 1, width: "100%" }}>
              <Grid container spacing={2}>
                <Grid size={12}>
                  <Typography sx={{ mt: 2, mb: 1 }}>
                    Step 1: Select campaign settings
                    {/* Include your form or content for Step 1 here */}
                  </Typography>
                </Grid>
                <Grid size={12}>
                  <TextField disabled id="outlined-disabled" label="Hotel Unique System ID" defaultValue={newHotelId} size="small" fullWidth />
                </Grid>
                <Grid size={{ xs: 8, sm: 9, md: 10 }}>
                  <FormControl fullWidth required variant="outlined" size="small">
                    <InputLabel htmlFor="hotel_name_label">Hotel Name</InputLabel>
                    <OutlinedInput
                      id="hotel_name_input"
                      label="Hotel Name"
                      value={hotelName}
                      onChange={handleHotelNameChange}
                      endAdornment={
                        <InputAdornment position="end">
                          <EndAdornment onClick={handleHotelNameGeneration} />
                        </InputAdornment>
                      }
                    />
                    <FormHelperText>We'll never share your email.</FormHelperText>
                  </FormControl>
                </Grid>
                <Grid size={{ xs: 4, sm: 3, md: 2 }} alignItems="center">
                  <AnimatedButton text="Auto" height={40} width={1} icon={<CalculateOutlinedIcon />} onClick={simulateAsyncOperation} />
                </Grid>
                <Grid size={6}>
                  <Autocomplete
                    disablePortal
                    onChange={setEnableCityChange}
                    options={[
                      { label: "Afghanistan", id: "AF" },
                      { label: "Albania", id: "AL" },
                      { label: "Algeria", id: "DZ" },
                      { label: "American Samoa", id: "AS" },
                      { label: "Andorra", id: "AD" },
                      { label: "Angola", id: "AO" },
                      { label: "Anguilla", id: "AI" },
                      { label: "Antarctica", id: "AQ" },
                      { label: "Antigua and Barbuda", id: "AG" },
                      { label: "Argentina", id: "AR" },
                      { label: "Armenia", id: "AM" },
                      { label: "Aruba", id: "AW" },
                      { label: "Australia", id: "AU" },
                      { label: "Austria", id: "AT" },
                      { label: "Azerbaijan", id: "AZ" },
                      { label: "Bahamas", id: "BS" },
                      { label: "Bahrain", id: "BH" },
                      { label: "Bangladesh", id: "BD" },
                      { label: "Barbados", id: "BB" },
                      { label: "Belarus", id: "BY" },
                      { label: "Belgium", id: "BE" },
                      { label: "Belize", id: "BZ" },
                      { label: "Benin", id: "BJ" },
                      { label: "Bermuda", id: "BM" },
                      { label: "Bhutan", id: "BT" },
                      { label: "Bolivia", id: "BO" },
                      { label: "Bonaire, Sint Eustatius, and Saba", id: "BQ" },
                      { label: "Bosnia and Herzegovina", id: "BA" },
                      { label: "Botswana", id: "BW" },
                      { label: "Bouvet Island", id: "BV" },
                      { label: "Brazil", id: "BR" },
                      { label: "British Indian Ocean Territory", id: "IO" },
                      { label: "British Virgin Islands", id: "VG" },
                      { label: "Brunei", id: "BN" },
                      { label: "Bulgaria", id: "BG" },
                      { label: "Burkina Faso", id: "BF" },
                      { label: "Burundi", id: "BI" },
                      { label: "Cabo Verde", id: "CV" },
                      { label: "Cambodia", id: "KH" },
                      { label: "Cameroon", id: "CM" },
                      { label: "Canada", id: "CA" },
                      { label: "Cayman Islands", id: "KY" },
                      { label: "Central African Republic", id: "CF" },
                      { label: "Chad", id: "TD" },
                      { label: "Chile", id: "CL" },
                      { label: "China", id: "CN" },
                      { label: "Christmas Island", id: "CX" },
                      { label: "Cocos (Keeling) Islands", id: "CC" },
                      { label: "Colombia", id: "CO" },
                      { label: "Comoros", id: "KM" },
                      { label: "Congo Republic", id: "CG" },
                      { label: "Cook Islands", id: "CK" },
                      { label: "Costa Rica", id: "CR" },
                      { label: "Croatia", id: "HR" },
                      { label: "Cuba", id: "CU" },
                      { label: "Curaçao", id: "CW" },
                      { label: "Cyprus", id: "CY" },
                      { label: "Czechia", id: "CZ" },
                      { label: "DR Congo", id: "CD" },
                      { label: "Denmark", id: "DK" },
                      { label: "Djibouti", id: "DJ" },
                      { label: "Dominica", id: "DM" },
                      { label: "Dominican Republic", id: "DO" },
                      { label: "Ecuador", id: "EC" },
                      { label: "Egypt", id: "EG" },
                      { label: "El Salvador", id: "SV" },
                      { label: "Equatorial Guinea", id: "GQ" },
                      { label: "Eritrea", id: "ER" },
                      { label: "Estonia", id: "EE" },
                      { label: "Eswatini", id: "SZ" },
                      { label: "Ethiopia", id: "ET" },
                      { label: "Falkland Islands", id: "FK" },
                      { label: "Faroe Islands", id: "FO" },
                      { label: "Fiji", id: "FJ" },
                      { label: "Finland", id: "FI" },
                      { label: "France", id: "FR" },
                      { label: "French Guiana", id: "GF" },
                      { label: "French Polynesia", id: "PF" },
                      { label: "French Southern Territories", id: "TF" },
                      { label: "Gabon", id: "GA" },
                      { label: "Georgia", id: "GE" },
                      { label: "Germany", id: "DE" },
                      { label: "Ghana", id: "GH" },
                      { label: "Gibraltar", id: "GI" },
                      { label: "Greece", id: "GR" },
                      { label: "Greenland", id: "GL" },
                      { label: "Grenada", id: "GD" },
                      { label: "Guadeloupe", id: "GP" },
                      { label: "Guam", id: "GU" },
                      { label: "Guatemala", id: "GT" },
                      { label: "Guernsey", id: "GG" },
                      { label: "Guinea", id: "GN" },
                      { label: "Guinea-Bissau", id: "GW" },
                      { label: "Guyana", id: "GY" },
                      { label: "Haiti", id: "HT" },
                      { label: "Heard and McDonald Islands", id: "HM" },
                      { label: "Honduras", id: "HN" },
                      { label: "Hong Kong", id: "HK" },
                      { label: "Hungary", id: "HU" },
                      { label: "Iceland", id: "IS" },
                      { label: "India", id: "IN" },
                      { label: "Indonesia", id: "ID" },
                      { label: "Iran", id: "IR" },
                      { label: "Iraq", id: "IQ" },
                      { label: "Ireland", id: "IE" },
                      { label: "Isle of Man", id: "IM" },
                      { label: "Israel", id: "IL" },
                      { label: "Italy", id: "IT" },
                      { label: "Ivory Coast", id: "CI" },
                      { label: "Jamaica", id: "JM" },
                      { label: "Japan", id: "JP" },
                      { label: "Jersey", id: "JE" },
                      { label: "Jordan", id: "JO" },
                      { label: "Kazakhstan", id: "KZ" },
                      { label: "Kenya", id: "KE" },
                      { label: "Kiribati", id: "KI" },
                      { label: "Kosovo", id: "XK" },
                      { label: "Kuwait", id: "KW" },
                      { label: "Kyrgyzstan", id: "KG" },
                      { label: "Laos", id: "LA" },
                      { label: "Latvia", id: "LV" },
                      { label: "Lebanon", id: "LB" },
                      { label: "Lesotho", id: "LS" },
                      { label: "Liberia", id: "LR" },
                      { label: "Libya", id: "LY" },
                      { label: "Liechtenstein", id: "LI" },
                      { label: "Lithuania", id: "LT" },
                      { label: "Luxembourg", id: "LU" },
                      { label: "Macao", id: "MO" },
                      { label: "Madagascar", id: "MG" },
                      { label: "Malawi", id: "MW" },
                      { label: "Malaysia", id: "MY" },
                      { label: "Maldives", id: "MV" },
                      { label: "Mali", id: "ML" },
                      { label: "Malta", id: "MT" },
                      { label: "Marshall Islands", id: "MH" },
                      { label: "Martinique", id: "MQ" },
                      { label: "Mauritania", id: "MR" },
                      { label: "Mauritius", id: "MU" },
                      { label: "Mayotte", id: "YT" },
                      { label: "Mexico", id: "MX" },
                      { label: "Micronesia", id: "FM" },
                      { label: "Moldova", id: "MD" },
                      { label: "Monaco", id: "MC" },
                      { label: "Mongolia", id: "MN" },
                      { label: "Montenegro", id: "ME" },
                      { label: "Montserrat", id: "MS" },
                      { label: "Morocco", id: "MA" },
                      { label: "Mozambique", id: "MZ" },
                      { label: "Myanmar", id: "MM" },
                      { label: "Namibia", id: "NA" },
                      { label: "Nauru", id: "NR" },
                      { label: "Nepal", id: "NP" },
                      { label: "New Caledonia", id: "NC" },
                      { label: "New Zealand", id: "NZ" },
                      { label: "Nicaragua", id: "NI" },
                      { label: "Niger", id: "NE" },
                      { label: "Nigeria", id: "NG" },
                      { label: "Niue", id: "NU" },
                      { label: "Norfolk Island", id: "NF" },
                      { label: "North Korea", id: "KP" },
                      { label: "North Macedonia", id: "MK" },
                      { label: "Northern Mariana Islands", id: "MP" },
                      { label: "Norway", id: "NO" },
                      { label: "Oman", id: "OM" },
                      { label: "Pakistan", id: "PK" },
                      { label: "Palau", id: "PW" },
                      { label: "Palestine", id: "PS" },
                      { label: "Panama", id: "PA" },
                      { label: "Papua New Guinea", id: "PG" },
                      { label: "Paraguay", id: "PY" },
                      { label: "Peru", id: "PE" },
                      { label: "Philippines", id: "PH" },
                      { label: "Pitcairn Islands", id: "PN" },
                      { label: "Poland", id: "PL" },
                      { label: "Portugal", id: "PT" },
                      { label: "Puerto Rico", id: "PR" },
                      { label: "Qatar", id: "QA" },
                      { label: "Romania", id: "RO" },
                      { label: "Russia", id: "RU" },
                      { label: "Rwanda", id: "RW" },
                      { label: "Réunion", id: "RE" },
                      { label: "Saint Barthélemy", id: "BL" },
                      { label: "Saint Helena", id: "SH" },
                      { label: "Saint Lucia", id: "LC" },
                      { label: "Saint Martin", id: "MF" },
                      { label: "Saint Pierre and Miquelon", id: "PM" },
                      { label: "Samoa", id: "WS" },
                      { label: "San Marino", id: "SM" },
                      { label: "Saudi Arabia", id: "SA" },
                      { label: "Senegal", id: "SN" },
                      { label: "Serbia", id: "RS" },
                      { label: "Seychelles", id: "SC" },
                      { label: "Sierra Leone", id: "SL" },
                      { label: "Singapore", id: "SG" },
                      { label: "Sint Maarten", id: "SX" },
                      { label: "Slovakia", id: "SK" },
                      { label: "Slovenia", id: "SI" },
                      { label: "Solomon Islands", id: "SB" },
                      { label: "Somalia", id: "SO" },
                      { label: "South Africa", id: "ZA" },
                      { label: "South Georgia and South Sandwich Islands", id: "GS" },
                      { label: "South Korea", id: "KR" },
                      { label: "South Sudan", id: "SS" },
                      { label: "Spain", id: "ES" },
                      { label: "Sri Lanka", id: "LK" },
                      { label: "St Kitts and Nevis", id: "KN" },
                      { label: "St Vincent and Grenadines", id: "VC" },
                      { label: "Sudan", id: "SD" },
                      { label: "Suriname", id: "SR" },
                      { label: "Svalbard and Jan Mayen", id: "SJ" },
                      { label: "Sweden", id: "SE" },
                      { label: "Switzerland", id: "CH" },
                      { label: "Syria", id: "SY" },
                      { label: "São Tomé and Príncipe", id: "ST" },
                      { label: "Taiwan", id: "TW" },
                      { label: "Tajikistan", id: "TJ" },
                      { label: "Tanzania", id: "TZ" },
                      { label: "Thailand", id: "TH" },
                      { label: "The Gambia", id: "GM" },
                      { label: "The Netherlands", id: "NL" },
                      { label: "Timor-Leste", id: "TL" },
                      { label: "Togo", id: "TG" },
                      { label: "Tokelau", id: "TK" },
                      { label: "Tonga", id: "TO" },
                      { label: "Trinidad and Tobago", id: "TT" },
                      { label: "Tunisia", id: "TN" },
                      { label: "Turkmenistan", id: "TM" },
                      { label: "Turks and Caicos Islands", id: "TC" },
                      { label: "Tuvalu", id: "TV" },
                      { label: "Türkiye", id: "TR" },
                      { label: "U.S. Outlying Islands", id: "UM" },
                      { label: "U.S. Virgin Islands", id: "VI" },
                      { label: "Uganda", id: "UG" },
                      { label: "Ukraine", id: "UA" },
                      { label: "United Arab Emirates", id: "AE" },
                      { label: "United Kingdom", id: "GB" },
                      { label: "United States", id: "US" },
                      { label: "Uruguay", id: "UY" },
                      { label: "Uzbekistan", id: "UZ" },
                      { label: "Vanuatu", id: "VU" },
                      { label: "Vatican City", id: "VA" },
                      { label: "Venezuela", id: "VE" },
                      { label: "Vietnam", id: "VN" },
                      { label: "Wallis and Futuna", id: "WF" },
                      { label: "Western Sahara", id: "EH" },
                      { label: "Yemen", id: "YE" },
                      { label: "Zambia", id: "ZM" },
                      { label: "Zimbabwe", id: "ZW" },
                      { label: "Åland", id: "AX" },
                    ]}
                    fullWidth
                    size="small"
                    renderInput={(params) => <TextField {...params} label="Country" />}
                  />
                </Grid>
                <Grid size={6}>
                  <Autocomplete
                    disablePortal
                    disabled={!enableCity}
                    options={["Riga", "Bauska"]}
                    fullWidth
                    size="small"
                    renderInput={(params) => <TextField {...params} label="City" />}
                  />
                </Grid>

                {/* Duplicate field as Test Value with plus button and validation */}
                <Grid size={{ xs: 12, sm: 12, md: 12 }}>
                  <FormControl fullWidth required variant="outlined" size="small">
                    <InputLabel htmlFor="test_value_label">Test Value</InputLabel>
                    <OutlinedInput
                      id="test_value_input"
                      label="Test Value"
                      value={testValue}
                      onChange={handleTestValueChange}
                      endAdornment={
                        <InputAdornment position="end">
                          <EndAdornment onClick={handleTestValueValidate} />
                        </InputAdornment>
                      }
                    />
                    <FormHelperText>Less than 10 chars = tick; more than 10 = cross.</FormHelperText>
                  </FormControl>
                </Grid>

                {/* Test Value using standard plus adornment (same generation logic) */}
                <Grid size={{ xs: 12, sm: 12, md: 12 }}>
                  <FormControl fullWidth required variant="outlined" size="small">
                    <InputLabel htmlFor="test_value_start_label">Test Value (Plus Button)</InputLabel>
                    <OutlinedInput
                      id="test_value_start_input"
                      label="Test Value (Plus Button)"
                      value={testValueStart}
                      onChange={handleTestValueStartChange}
                      endAdornment={
                        <InputAdornment position="end">
                          <EndAdornment onClick={handleTestValueStartValidate} />
                        </InputAdornment>
                      }
                    />
                    <FormHelperText>Random number 1-10: less than 5 = green tick, 5 or more = red cross.</FormHelperText>
                  </FormControl>
                </Grid>
              </Grid>
            </Box>
          )}
          {activeStep === 1 && (
            <Typography sx={{ mt: 2, mb: 1 }}>
              Step 2: Create an ad group
              {/* Include your form or content for Step 2 here */}
            </Typography>
          )}
          {activeStep === 2 && (
            <Typography sx={{ mt: 2, mb: 1 }}>
              Step 3: Create an ad
              {/* Include your form or content for Step 3 here */}
            </Typography>
          )}
          <Box sx={{ display: "flex", flexDirection: "row", pt: 2 }}>
            <Button color="inherit" disabled={activeStep === 0} onClick={handleBack} sx={{ mr: 1 }}>
              Back
            </Button>
            <Box sx={{ flex: "1 1 auto" }} />
            {isStepOptional(activeStep) && (
              <Button color="inherit" onClick={handleSkip} sx={{ mr: 1 }}>
                Skip
              </Button>
            )}
            <Button onClick={handleNext}>{activeStep === totalSteps - 1 ? "Finish" : "Next"}</Button>
          </Box>
        </React.Fragment>
      )}
    </Box>
  );
}
