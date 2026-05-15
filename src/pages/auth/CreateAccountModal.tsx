
import React, { useState, useEffect, useRef } from 'react';
import './LoginScreen.css';
// import { V2SetToken } from '@/external/bot-skeleton/services/api/appId';

const country_list = {
    "AF": "Afghanistan", "AL": "Albania", "DZ": "Algeria", "AS": "American Samoa", "AD": "Andorra", "AO": "Angola", "AI": "Anguilla", "AQ": "Antarctica", "AG": "Antigua and Barbuda",
    "AR": "Argentina", "AM": "Armenia", "AW": "Aruba", "AU": "Australia", "AT": "Austria", "AZ": "Azerbaijan", "BS": "Bahamas", "BH": "Bahrain", "BD": "Bangladesh", "BB": "Barbados",
    "BY": "Belarus", "BE": "Belgium", "BZ": "Belize", "BJ": "Benin", "BM": "Bermuda", "BT": "Bhutan", "BO": "Bolivia", "BA": "Bosnia and Herzegovina", "BW": "Botswana", "BR": "Brazil",
    "IO": "British Indian Ocean Territory", "BN": "Brunei Darussalam", "BG": "Bulgaria", "BF": "Burkina Faso", "BI": "Burundi", "KH": "Cambodia", "CM": "Cameroon", "CA": "Canada",
    "CV": "Cape Verde", "KY": "Cayman Islands", "CF": "Central African Republic", "TD": "Chad", "CL": "Chile", "CN": "China", "CX": "Christmas Island", "CC": "Cocos (Keeling) Islands",
    "CO": "Colombia", "KM": "Comoros", "CG": "Congo", "CD": "Congo, The Democratic Republic of the", "CK": "Cook Islands", "CR": "Costa Rica", "CI": "Cote D'Ivoire", "HR": "Croatia",
    "CU": "Cuba", "CY": "Cyprus", "CZ": "Czech Republic", "DK": "Denmark", "DJ": "Djibouti", "DM": "Dominica", "DO": "Dominican Republic", "EC": "Ecuador", "EG": "Egypt", "SV": "El Salvador",
    "GQ": "Equatorial Guinea", "ER": "Eritrea", "EE": "Estonia", "ET": "Ethiopia", "FK": "Falkland Islands (Malvinas)", "FO": "Faroe Islands", "FJ": "Fiji", "FI": "Finland", "FR": "France",
    "GF": "French Guiana", "PF": "French Polynesia", "GA": "Gabon", "GM": "Gambia", "GE": "Georgia", "DE": "Germany", "GH": "Ghana", "GI": "Gibraltar", "GR": "Greece", "GL": "Greenland",
    "GD": "Grenada", "GP": "Guadeloupe", "GU": "Guam", "GT": "Guatemala", "GN": "Guinea", "GW": "Guinea-Bissau", "GY": "Guyana", "HT": "Haiti", "HN": "Honduras", "HK": "Hong Kong",
    "HU": "Hungary", "IS": "Iceland", "IN": "India", "ID": "Indonesia", "IR": "Iran, Islamic Republic of", "IQ": "Iraq", "IE": "Ireland", "IM": "Isle of Man", "IL": "Israel", "IT": "Italy",
    "JM": "Jamaica", "JP": "Japan", "JE": "Jersey", "JO": "Jordan", "KZ": "Kazakhstan", "KE": "Kenya", "KI": "Kiribati", "KP": "Korea, Democratic People's Republic of", "KR": "Korea, Republic of",
    "KW": "Kuwait", "KG": "Kyrgyzstan", "LA": "Lao People's Democratic Republic", "LV": "Latvia", "LB": "Lebanon", "LS": "Lesotho", "LR": "Liberia", "LY": "Libyan Arab Jamahiriya",
    "LI": "Liechtenstein", "LT": "Lithuania", "LU": "Luxembourg", "MO": "Macao", "MK": "Macedonia, The Former Yugoslav Republic of", "MG": "Madagascar", "MW": "Malawi", "MY": "Malaysia",
    "MV": "Maldives", "ML": "Mali", "MT": "Malta", "MH": "Marshall Islands", "MQ": "Martinique", "MR": "Mauritania", "MU": "Mauritius", "MX": "Mexico", "FM": "Micronesia, Federated States of",
    "MD": "Moldova, Republic of", "MC": "Monaco", "MN": "Mongolia", "ME": "Montenegro", "MS": "Montserrat", "MA": "Morocco", "MZ": "Mozambique", "MM": "Myanmar", "NA": "Namibia", "NR": "Nauru",
    "NP": "Nepal", "NL": "Netherlands", "AN": "Netherlands Antilles", "NC": "New Caledonia", "NZ": "New Zealand", "NI": "Nicaragua", "NE": "Niger", "NG": "Nigeria", "NU": "Niue",
    "NF": "Norfolk Island", "MP": "Northern Mariana Islands", "NO": "Norway", "OM": "Oman", "PK": "Pakistan", "PW": "Palau", "PA": "Panama", "PG": "Papua New Guinea", "PY": "Paraguay",
    "PE": "Peru", "PH": "Philippines", "PL": "Poland", "PT": "Portugal", "PR": "Puerto Rico", "QA": "Qatar", "RE": "Reunion", "RO": "Romania", "RU": "Russian Federation", "RW": "Rwanda",
    "SH": "Saint Helena", "KN": "Saint Kitts and Nevis", "LC": "Saint Lucia", "PM": "Saint Pierre and Miquelon", "VC": "Saint Vincent and the Grenadines", "WS": "Samoa", "SM": "San Marino",
    "ST": "Sao Tome and Principe", "SA": "Saudi Arabia", "SN": "Senegal", "RS": "Serbia", "SC": "Seychelles", "SL": "Sierra Leone", "SG": "Singapore", "SK": "Slovakia", "SI": "Slovenia",
    "SB": "Solomon Islands", "SO": "Somalia", "ZA": "South Africa", "GS": "South Georgia and the South Sandwich Islands", "ES": "Spain", "LK": "Sri Lanka", "SD": "Sudan",
    "SR": "Suriname", "SZ": "Swaziland", "SE": "Sweden", "CH": "Switzerland", "SY": "Syrian Arab Republic", "TW": "Taiwan, Province of China", "TJ": "Tajikistan",
    "TZ": "Tanzania, United Republic of", "TH": "Thailand", "TL": "Timor-Leste", "TG": "Togo", "TK": "Tokelau", "TO": "Tonga", "TT": "Trinidad and Tobago", "TN": "Tunisia", "TR": "Turkey",
    "TM": "Turkmenistan", "TC": "Turks and Caicos Islands", "TV": "Tuvalu", "UG": "Uganda", "UA": "Ukraine", "AE": "United Arab Emirates", "GB": "United Kingdom", "US": "United States",
    "UY": "Uruguay", "UZ": "Uzbekistan", "VU": "Vanuatu", "VE": "Venezuela", "VN": "Viet Nam", "VG": "Virgin Islands, British", "VI": "Virgin Islands, U.S.", "WF": "Wallis and Futuna",
    "EH": "Western Sahara", "YE": "Yemen", "ZM": "Zambia", "ZW": "Zimbabwe"
};

const PasswordStrength = ({ password }) => {
    const getStrength = () => {
        let score = 0;
        if (password.length >= 8) score++;
        if (/[A-Z]/.test(password)) score++;
        if (/[a-z]/.test(password)) score++;
        if (/[0-9]/.test(password)) score++;
        if (/[^A-Za-z0-9]/.test(password)) score++;
        
        if (password.length === 0) return '';
        if (score <= 2) return 'weak';
        if (score <= 3) return 'fair';
        if (score <= 4) return 'good';
        return 'strong';
    };

    const strength = getStrength();
    const strength_map = { weak: 1, fair: 2, good: 3, strong: 4 };

    return (
        <div className="password-strength-bar">
            {Array.from({ length: 4 }).map((_, idx) => (
                <div 
                    key={idx}
                    className={`strength-segment ${idx < strength_map[strength] ? 'filled' : ''}`}
                    data-strength={strength}
                />
            ))}
        </div>
    );
};


export const CreateAccountModal = ({ isOpen, onClose }) => {
    const [stage, setStage] = useState(1);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [residence, setResidence] = useState('ke');
    const [verificationCode, setVerificationCode] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState('');
    const [isSuccess, setIsSuccess] = useState(false);
    const ws = useRef(null);

    useEffect(() => {
        if (isOpen) {
            connectWebSocket();
        }
        return () => {
            if (ws.current) {
                ws.current.close();
            }
        };
    }, [isOpen]);
    
    const [isExiting, setIsExiting] = useState(false);

    const handleClose = () => {
        setIsExiting(true);
        setTimeout(() => {
            onClose();
            setIsExiting(false);
            // Reset state
            setStage(1);
            setEmail('');
            setPassword('');
            setConfirmPassword('');
            setResidence('ke');
            setVerificationCode('');
            setError('');
            setIsLoading(false);
            setIsSuccess(false);

        }, 400); 
    };

    const connectWebSocket = () => {
        ws.current = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=101585');
        ws.current.onopen = () => console.log('WebSocket for account creation connected');
        ws.current.onmessage = handleWebSocketMessage;
        ws.current.onclose = () => console.log('WebSocket for account creation disconnected');
        ws.current.onerror = (err) => setError('WebSocket connection error. Please try again.');
    };

    const handleWebSocketMessage = (event) => {
        const data = JSON.parse(event.data);
        setIsLoading(false);

        if (data.error) {
            setError(data.error.message);
            return;
        }

        if (data.msg_type === 'verify_email') {
            if (data.verify_email === 1) {
                setStage(2);
                setError('');
            }
        }

        if (data.msg_type === 'new_account_virtual') {
            setIsSuccess(true);
            const { oauth_token, client_id } = data.new_account_virtual;
            // V2SetToken(client_id, { token: oauth_token, loginid: client_id });
            setTimeout(() => {
                window.location.reload();
            }, 2000);
        }
    };
    
    const sendWebSocketMessage = (message) => {
        if (ws.current && ws.current.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify(message));
        } else {
            setError('Connection lost. Please try again.');
            connectWebSocket(); // Attempt to reconnect
        }
    };

    const handleSendVerificationCode = (e) => {
        e.preventDefault();
        if (password !== confirmPassword) {
            setError('Passwords do not match.');
            return;
        }
        setError('');
        setIsLoading(true);
        sendWebSocketMessage({
            verify_email: email,
            type: 'account_opening',
            req_id: 1,
        });
    };

    const handleCreateAccount = (e) => {
        e.preventDefault();
        setError('');
        setIsLoading(true);
        sendWebSocketMessage({
            new_account_virtual: 1,
            client_password: password,
            verification_code: verificationCode,
            type: 'trading',
            residence: residence,
            date_first_contact: new Date().toISOString().split('T')[0],
            signup_device: 'browser',
            req_id: 2,
        });
    };

    if (!isOpen) return null;

    return (
        <div className={`modal-overlay ${isExiting ? 'exiting' : ''}`} onClick={handleClose}>
            <div className={`modal-content ${isExiting ? 'exiting' : ''}`} onClick={e => e.stopPropagation()}>
                <button className="modal-close-btn" onClick={handleClose}>&times;</button>
                
                {isSuccess ? (
                    <div className="success-animation">
                        <div className="checkmark-circle">
                            <div className="background"></div>
                            <svg viewBox="0 0 52 52">
                                <path className="checkmark" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
                            </svg>
                        </div>
                        <h3>Account Created!</h3>
                        <p>Logging you in...</p>
                    </div>
                ) : (
                    <>
                        <div className="modal-header">
                            <h2>Create New Account</h2>
                            <div className="progress-indicator">
                                <div className="progress-step">
                                    <div className={`progress-dot ${stage === 1 ? 'active' : ''}`}></div>
                                    <span>Account Details</span>
                                </div>
                                <div className="progress-step">
                                    <div className={`progress-dot ${stage === 2 ? 'active' : ''}`}></div>
                                    <span>Verify Email</span>
                                </div>
                            </div>
                        </div>

                        {stage === 1 && (
                            <form onSubmit={handleSendVerificationCode}>
                                <div className="form-group">
                                    <label>Email Address</label>
                                    <input type="email" value={email} onChange={e => setEmail(e.target.value)} required />
                                </div>
                                <div className="form-group">
                                    <label>Password</label>
                                    <input type="password" value={password} onChange={e => setPassword(e.target.value)} required />
                                    <PasswordStrength password={password} />
                                </div>
                                 <div className="form-group">
                                    <label>Confirm Password</label>
                                    <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required />
                                </div>
                                <div className="form-group">
                                    <label>Country of Residence</label>
                                    <select className="country-dropdown" value={residence} onChange={e => setResidence(e.target.value)} required>
                                        {Object.entries(country_list).map(([code, name]) => (
                                            <option key={code} value={code.toLowerCase()}>{name}</option>
                                        ))}
                                    </select>
                                </div>
                                <button type="submit" className={`btn btn-new-login ${isLoading ? 'loading' : ''}`} disabled={isLoading}>
                                    <span className="btn-text">Send Verification Code</span>
                                    <div className="loader"></div>
                                </button>
                            </form>
                        )}

                        {stage === 2 && (
                             <form onSubmit={handleCreateAccount}>
                                <p>Check your email for the verification code.</p>
                                <div className="form-group">
                                    <label>Verification Code</label>
                                    <input type="text" value={verificationCode} onChange={e => setVerificationCode(e.target.value)} required maxLength={8} />
                                </div>
                                <button type="submit" className={`btn btn-new-login ${isLoading ? 'loading' : ''}`} disabled={isLoading}>
                                     <span className="btn-text">Create My Account</span>
                                    <div className="loader"></div>
                                </button>
                                <button type="button" onClick={() => handleSendVerificationCode(new Event('submit'))} className="resend-code-link" disabled={isLoading}>
                                    Resend code
                                </button>
                            </form>
                        )}
                        {error && <div className="error-banner">{error}</div>}
                    </>
                )}
            </div>
        </div>
    );
};

export default CreateAccountModal;
